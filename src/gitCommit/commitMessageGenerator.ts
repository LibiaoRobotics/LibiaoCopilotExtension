import * as path from "path";
import * as vscode from "vscode";
import { getGitDiff } from "./gitUtils";
import { OpenaiApi } from "../openai/openaiApi";
import { OpenaiResponsesApi } from "../openai/openaiResponsesApi";
import { AnthropicApi } from "../anthropic/anthropicApi";
import { OllamaApi } from "../ollama/ollamaApi";
import { GeminiApi } from "../gemini/geminiApi";
import {
	normalizeUserModels,
	parseModelId,
	getBuiltInModel,
	DEFAULT_COMMIT_MODEL,
	getRecommendedCommitModels,
	resolveValidCommitModel,
} from "../utils";
import { logger } from "../logger";
import { CommitStreamIncompleteReason } from "../commonApi";

/**
 * Git commit message generator module
 */

let commitGenerationAbortController: AbortController | undefined;

/** Minimal structural type for a repository from the vscode.git extension API. */
interface GitRepositoryState {
	indexChanges?: unknown[];
	workingTreeChanges?: unknown[];
	untrackedChanges?: unknown[];
	mergeChanges?: unknown[];
}

interface GitRepository {
	rootUri: vscode.Uri;
	inputBox: { value: string };
	state?: GitRepositoryState;
	status?: () => Promise<void>;
}

/** 提交信息 prompt 里 diff 部分的字符上限（超过则明显标记截断，而不是静默削掉）。 */
const MAX_DIFF_PROMPT_CHARS = 100000;

const DEFAULT_PROMPT = {
	system:
		"You are a helpful assistant that generates informative git commit messages based on git diffs output. Skip preamble and remove all backticks surrounding the commit message.\nBased on the provided git diff, generate a conventional format commit message.",
	user: "Notes from developer (ignore if not relevant): {{USER_CURRENT_INPUT}}",
};

export async function generateCommitMsg(secrets: vscode.SecretStorage, scm?: vscode.SourceControl) {
	try {
		const gitExtension = vscode.extensions.getExtension("vscode.git")?.exports;
		if (!gitExtension) {
			throw new Error("Git extension not found");
		}

		const git = gitExtension.getAPI(1);
		if (git.repositories.length === 0) {
			throw new Error("No Git repositories available");
		}

		// If scm is provided, then the user specified one repository by clicking the "Source Control" menu button
		if (scm) {
			const repository = git.getRepository(scm.rootUri);

			if (!repository) {
				throw new Error("Repository not found for provided SCM");
			}

			await refreshRepositoryState(repository);
			await generateCommitMsgForRepository(secrets, repository);
			return;
		}

		await orchestrateWorkspaceCommitMsgGeneration(secrets, git.repositories);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`[Commit Generation Failed] ${errorMessage}`);
	}
}

async function orchestrateWorkspaceCommitMsgGeneration(secrets: vscode.SecretStorage, repos: GitRepository[]) {
	const { repos: reposWithChanges, errors } = await filterForReposWithChanges(repos);

	if (reposWithChanges.length === 0) {
		if (errors.length > 0) {
			// 有仓库是因为读改动失败才没入选：必须把真实原因告诉用户，不能谎报「没有改动」。
			vscode.window.showErrorMessage(`无法读取待提交改动：\n${errors.join("\n")}`);
		} else {
			vscode.window.showInformationMessage(`工作区内的仓库都没有待提交的改动。`);
		}
		return;
	}

	if (errors.length > 0) {
		logger.error("commit.repoScan.partial", { errors: errors.join(" | ") });
	}

	if (reposWithChanges.length === 1) {
		// Only one repo with changes, generate for it
		const repo = reposWithChanges[0];
		await generateCommitMsgForRepository(secrets, repo);
		return;
	}

	const selection = await promptRepoSelection(reposWithChanges);

	if (!selection) {
		// User cancelled
		return;
	}

	if (selection.repo === null) {
		// Generate for all repositories with changes
		for (const repo of reposWithChanges) {
			try {
				await generateCommitMsgForRepository(secrets, repo);
			} catch (error) {
				console.error(`Failed to generate commit message for ${repo.rootUri.fsPath}:`, error);
			}
		}
	} else {
		// Generate for selected repository
		await generateCommitMsgForRepository(secrets, selection.repo);
	}
}

/** 强制刷新仓库状态，避免外部 git 操作导致的 state 滞后。 */
async function refreshRepositoryState(repo: GitRepository): Promise<void> {
	if (typeof repo.status !== "function") {
		return;
	}
	try {
		await repo.status();
	} catch (error) {
		// 刷新失败不影响判断：后面的 CLI diff 仍会给出结果。
		console.warn(`[Libiao Copilot] 刷新仓库状态失败 ${repo.rootUri.fsPath}:`, error);
	}
}

/** 仓库是否存在待提交的改动（暂存/未暂存/未跟踪/合并冲突任一非空）。 */
function hasRepositoryChanges(repo: GitRepository): boolean {
	const state = repo.state;
	if (!state) {
		return false;
	}
	return [state.indexChanges, state.workingTreeChanges, state.untrackedChanges, state.mergeChanges].some(
		(group) => Array.isArray(group) && group.length > 0
	);
}

async function filterForReposWithChanges(repos: GitRepository[]): Promise<{ repos: GitRepository[]; errors: string[] }> {
	const reposWithChanges: GitRepository[] = [];
	const errors: string[] = [];

	for (const repo of repos) {
		const repoName = repo.rootUri.fsPath.split(path.sep).pop() || repo.rootUri.fsPath;

		// 以 vscode.git 的仓库状态作为权威判据：它有改动就一定有东西可提交，
		// 不再依赖 diff 文本是否为空（旧逻辑会因删除文件、未跟踪文件、无提交仓库而误判）。
		await refreshRepositoryState(repo);
		if (hasRepositoryChanges(repo)) {
			reposWithChanges.push(repo);
			continue;
		}

		// 状态里看不到改动时，再用 CLI diff 复核一次，避免 state 未及时同步时丢掉真实改动。
		try {
			const gitDiff = await getGitDiff(repo.rootUri.fsPath);
			if (gitDiff) {
				reposWithChanges.push(repo);
			}
		} catch (error) {
			errors.push(`${repoName}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return { repos: reposWithChanges, errors };
}

async function promptRepoSelection(repos: GitRepository[]) {
	// Multiple repos with changes - ask user to choose
	const repoItems: (vscode.QuickPickItem & { repo: GitRepository | null })[] = repos.map((repo) => ({
		label: repo.rootUri.fsPath.split(path.sep).pop() || repo.rootUri.fsPath,
		description: repo.rootUri.fsPath,
		repo: repo,
	}));

	repoItems.unshift({
		label: "$(git-commit) Generate for all repositories with changes",
		description: `Generate commit messages for ${repos.length} repositories`,
		repo: null,
	});

	return await vscode.window.showQuickPick(repoItems, {
		placeHolder: "Select repository for commit message generation",
	});
}

async function generateCommitMsgForRepository(secrets: vscode.SecretStorage, repository: GitRepository) {
	const inputBox = repository.inputBox;
	const repoPath = repository.rootUri.fsPath;
	const repoName = repoPath.split(path.sep).pop() || "repository";

	const gitDiff = await getGitDiff(repoPath);

	if (!gitDiff) {
		if (hasRepositoryChanges(repository)) {
			throw new Error(`仓库 ${repoName} 有改动但未能生成 diff，请检查是否被 .gitignore 或 git 配置排除。`);
		}
		vscode.window.showInformationMessage(`仓库 ${repoName} 没有待提交的改动。`);
		return;
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.SourceControl,
			title: `Generating commit message for ${repoName}...`,
			cancellable: true,
		},
		(_progress, token) => performCommitMsgGeneration(secrets, gitDiff, inputBox, token)
	);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || /abort/i.test(error.message));
}

async function performCommitMsgGeneration(
	secrets: vscode.SecretStorage,
	gitDiff: string,
	inputBox: { value: string },
	token?: vscode.CancellationToken
) {
	const startTime = Date.now();
	let modelId: string | undefined;
	const cancellationSubscription = token?.onCancellationRequested(() => abortCommitGeneration());
	try {
		vscode.commands.executeCommand("setContext", "libiaoCopilot.isGeneratingCommit", true);
		const config = vscode.workspace.getConfiguration();

		// Get custom prompts or use defaults
		const customSystemPrompt = config.get<string>("libiaoCopilot.commitMessagePrompt", "");
		const PROMPT = {
			system: customSystemPrompt || DEFAULT_PROMPT.system,
			user: DEFAULT_PROMPT.user,
		};

		const prompts: string[] = [];

		const currentInput = inputBox.value?.trim() || "";
		if (currentInput) {
			prompts.push(PROMPT.user.replace("{{USER_CURRENT_INPUT}}", currentInput));
		}

		const truncatedDiff =
			gitDiff.length > MAX_DIFF_PROMPT_CHARS
				? `${gitDiff.substring(0, MAX_DIFF_PROMPT_CHARS)}\n\n[Diff truncated: 超出 ${MAX_DIFF_PROMPT_CHARS} 字符上限，后续改动未包含]`
				: gitDiff;
		prompts.push(truncatedDiff);
		const prompt = prompts.join("\n\n");

		// Get user models from configuration
		const userModels = normalizeUserModels(config.get<unknown>("libiaoCopilot.models", []));
		const recommendedCommitModels = getRecommendedCommitModels(userModels);

		// 提交信息生成模型：读独立配置项 libiaoCopilot.commitModel 并进行纠偏
		const configuredCommitModel = config.get<string>("libiaoCopilot.commitModel", DEFAULT_COMMIT_MODEL);
		const validCommitModel = resolveValidCommitModel(configuredCommitModel, recommendedCommitModels);

		// 若检测到历史残留或非推荐模型，静默自动纠偏配置
		if (configuredCommitModel !== validCommitModel) {
			void config.update("libiaoCopilot.commitModel", validCommitModel, vscode.ConfigurationTarget.Global);
		}

		const { baseId, configId } = parseModelId(validCommitModel);
		let selectedModel = userModels.find(
			(m) => m.id === baseId && ((configId && m.configId === configId) || (!configId && !m.configId))
		);
		// 用户配置里没有该模型时，回退到内置模型表（含供应商元数据）
		if (!selectedModel) {
			selectedModel = getBuiltInModel(baseId);
		}

		if (!selectedModel) {
			throw new Error(
				`No model configured for commit message generation. Set 'libiaoCopilot.commitModel' to a model id from your configuration.`
			);
		}

		modelId = selectedModel.id;
		logger.info("commit.start", { modelId });

		// Get API key for the model's provider
		const apiKey = await ensureApiKey(secrets, selectedModel.owned_by);
		if (!apiKey) {
			throw new Error("OAI Compatible API key not found");
		}

		// Get base URL for the model
		const baseUrl = selectedModel.baseUrl || config.get<string>("libiaoCopilot.baseUrl", "");
		if (!baseUrl || !baseUrl.startsWith("http")) {
			throw new Error(`Invalid base URL configuration.`);
		}

		// Get commit language configuration
		const commitLanguage = config.get<string>("libiaoCopilot.commitLanguage", "Chinese (Simplified)");

		// Create a system prompt with language instruction
		const systemPrompt = PROMPT.system + ` Generate commit message in ${commitLanguage}.`;

		// Create a message for the API
		const messages = [{ role: "user", content: prompt }];

		// Create API instance based on model's API mode
		let apiInstance;
		const apiMode = selectedModel.apiMode ?? "openai";

		if (apiMode === "anthropic") {
			apiInstance = new AnthropicApi(modelId);
		} else if (apiMode === "ollama") {
			apiInstance = new OllamaApi(modelId);
		} else if (apiMode === "gemini") {
			apiInstance = new GeminiApi(modelId);
		} else if (apiMode === "openai-responses") {
			apiInstance = new OpenaiResponsesApi(modelId);
		} else {
			// Default to OpenAI-compatible API
			apiInstance = new OpenaiApi(modelId);
		}

		commitGenerationAbortController = new AbortController();
		const abortController = commitGenerationAbortController;
		const stream = apiInstance.createMessage(
			selectedModel,
			systemPrompt,
			messages,
			baseUrl,
			apiKey,
			abortController.signal
		);

		let response = "";
		let incompleteReason: CommitStreamIncompleteReason | undefined;

		// inputBox.value 的读回可能滞后再写入，文本一律由 response 派生，避免尾部被裁掉。
		const renderToInputBox = () => {
			inputBox.value = removeThinkTags(extractCommitMessage(response));
		};

		for await (const chunk of stream) {
			if (abortController.signal.aborted) {
				break;
			}
			if (chunk.type === "text") {
				response += chunk.text;
				renderToInputBox();
			} else if (chunk.type === "replace") {
				// 服务端在收尾时给出权威全文，直接覆盖增量拼接结果，避免末尾缺字。
				response = chunk.text;
				renderToInputBox();
			} else if (chunk.type === "incomplete") {
				incompleteReason = chunk.reason;
			}
		}

		const finalMessage = removeThinkTags(extractCommitMessage(response));
		inputBox.value = finalMessage;

		if (!finalMessage) {
			throw new Error("empty API response");
		}

		logger.info("commit.end", {
			modelId,
			durationMs: Date.now() - startTime,
			outputChars: response.length,
			renderedChars: finalMessage.length,
			diffChars: gitDiff.length,
			incompleteReason: incompleteReason ?? "none",
			tailPreview: finalMessage.slice(-80),
		});

		// 静默截断是「提交信息断了一截」的主因：结束时不完整就必须告知用户。
		if (incompleteReason === "length") {
			void vscode.window.showWarningMessage(
				`提交信息可能未生成完整（模型输出达到上限，已生成 ${finalMessage.length} 字）。请检查内容后再提交，或重新生成。`
			);
		} else if (incompleteReason === "unexpected-end") {
			void vscode.window.showWarningMessage("提交信息流式响应意外中断，当前内容可能不完整，请重新生成。");
		} else if (incompleteReason === "failed") {
			void vscode.window.showWarningMessage("服务端报告本次生成未正常完成，当前内容可能不完整，请重新生成。");
		}
	} catch (error) {
		if (isAbortError(error)) {
			// 用户主动取消：保留已生成的部分内容，不再弹错误。
			logger.info("commit.aborted", { modelId: modelId ?? "unknown" });
			return;
		}
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error("commit.error", { modelId: modelId ?? "unknown", error: errorMessage });
		vscode.window.showErrorMessage(`Failed to generate commit message: ${errorMessage}`);
	} finally {
		cancellationSubscription?.dispose();
		commitGenerationAbortController = undefined;
		vscode.commands.executeCommand("setContext", "libiaoCopilot.isGeneratingCommit", false);
	}
}

export function abortCommitGeneration() {
	commitGenerationAbortController?.abort();
	vscode.commands.executeCommand("setContext", "libiaoCopilot.isGeneratingCommit", false);
}

/**
 * Extracts the commit message from the AI response
 * @param str String containing the AI response
 * @returns The extracted commit message
 */
function extractCommitMessage(str: string): string {
	// Remove any markdown formatting or extra text
	return str
		.trim()
		.replace(/^```[^\n]*\n?|```$/g, "")
		.trim();
}

function removeThinkTags(text: string): string {
	const regex = /<think>.*?<\/think>/gs;
	return text.replace(regex, "").trim();
}

/**
 * Ensure an API key exists in SecretStorage
 * @param provider provider name to get provider-specific API key.
 */
async function ensureApiKey(secrets: vscode.SecretStorage, provider: string): Promise<string | undefined> {
	let apiKey: string | undefined;
	if (provider && provider.trim() !== "") {
		const normalizedProvider = provider.trim().toLowerCase();
		const providerKey = `libiaoCopilot.apiKey.${normalizedProvider}`;
		apiKey = await secrets.get(providerKey);
	}

	// Fall back to generic API key
	if (!apiKey) {
		apiKey = await secrets.get("libiaoCopilot.apiKey");
	}

	return apiKey;
}
