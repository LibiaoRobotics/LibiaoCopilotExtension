import * as vscode from "vscode";
import type { HFModelItem } from "./types";
import { normalizeUserModels } from "./utils";

export interface ModelHealthResult {
	modelId: string;
	status: "available" | "unavailable" | "skipped";
	latencyMs: number;
	detail: string;
}

const LAST_STARTUP_CHECK_KEY = "libiaoCopilot.lastStartupHealthCheck";

async function getApiKey(secrets: vscode.SecretStorage, model: HFModelItem): Promise<string | undefined> {
	if (model.baseUrl && model.owned_by) {
		const providerKey = await secrets.get(`libiaoCopilot.apiKey.${model.owned_by.toLowerCase()}`);
		if (providerKey) {
			return providerKey;
		}
	}
	return secrets.get("libiaoCopilot.apiKey");
}

async function checkModel(
	model: HFModelItem,
	baseUrl: string,
	secrets: vscode.SecretStorage,
	timeoutMs: number
): Promise<ModelHealthResult> {
	const startedAt = Date.now();
	if ((model.apiMode ?? "openai") !== "openai") {
		return {
			modelId: model.id,
			status: "skipped",
			latencyMs: 0,
			detail: `Health check does not support apiMode=${model.apiMode}`,
		};
	}

	const apiKey = await getApiKey(secrets, model);
	if (!apiKey) {
		return { modelId: model.id, status: "unavailable", latencyMs: 0, detail: "API key is not configured" };
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const endpoint = `${(model.baseUrl || baseUrl).replace(/\/+$/, "")}/chat/completions`;
		const response = await fetch(endpoint, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				...model.headers,
			},
			body: JSON.stringify({
				model: model.id,
				messages: [{ role: "user", content: "Reply with OK." }],
				max_tokens: 1,
				stream: false,
			}),
			signal: controller.signal,
		});
		const latencyMs = Date.now() - startedAt;
		if (response.ok) {
			return { modelId: model.id, status: "available", latencyMs, detail: `HTTP ${response.status}` };
		}
		const responseText = (await response.text()).slice(0, 200).replace(/\s+/g, " ");
		return {
			modelId: model.id,
			status: "unavailable",
			latencyMs,
			detail: `HTTP ${response.status}${responseText ? `: ${responseText}` : ""}`,
		};
	} catch (error) {
		const detail = error instanceof Error && error.name === "AbortError"
			? `Timed out after ${timeoutMs} ms`
			: error instanceof Error ? error.message : String(error);
		return { modelId: model.id, status: "unavailable", latencyMs: Date.now() - startedAt, detail };
	} finally {
		clearTimeout(timeout);
	}
}

export async function checkAllModels(
	secrets: vscode.SecretStorage,
	showResults: boolean
): Promise<ModelHealthResult[]> {
	const config = vscode.workspace.getConfiguration();
	const models = normalizeUserModels(config.get<unknown>("libiaoCopilot.models", []))
		.filter((model) => !model.id.startsWith("__provider__"));
	const baseUrl = config.get<string>("libiaoCopilot.baseUrl", "");
	const timeoutMs = config.get<number>("libiaoCopilot.healthCheckTimeout", 15_000);

	const checkOperation = () => Promise.all(models.map((model) => checkModel(model, baseUrl, secrets, timeoutMs)));
	const results = showResults
		? await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: "Libiao Copilot: Checking model availability",
				cancellable: false,
			},
			checkOperation
		)
		: await checkOperation();

	if (showResults) {
		const items = results.map((result) => ({
			label: `${result.status === "available" ? "$(pass)" : result.status === "skipped" ? "$(circle-slash)" : "$(error)"} ${result.modelId}`,
			description: result.latencyMs > 0 ? `${result.latencyMs} ms` : result.status,
			detail: result.detail,
		}));
		await vscode.window.showQuickPick(items, {
			title: "Libiao Copilot Model Availability",
			placeHolder: `${results.filter((result) => result.status === "available").length}/${results.length} models available`,
		});
	}

	return results;
}

export async function runStartupHealthCheck(context: vscode.ExtensionContext): Promise<void> {
	const config = vscode.workspace.getConfiguration();
	if (!config.get<boolean>("libiaoCopilot.checkModelsOnStartup", true)) {
		return;
	}
	const models = normalizeUserModels(config.get<unknown>("libiaoCopilot.models", []))
		.filter((model) => !model.id.startsWith("__provider__"));
	const configuredKeys = await Promise.all(models.map((model) => getApiKey(context.secrets, model)));
	if (!configuredKeys.some(Boolean)) {
		return;
	}

	const intervalHours = config.get<number>("libiaoCopilot.startupCheckIntervalHours", 24);
	const lastCheck = context.globalState.get<number>(LAST_STARTUP_CHECK_KEY, 0);
	if (Date.now() - lastCheck < intervalHours * 60 * 60 * 1000) {
		return;
	}

	const results = await checkAllModels(context.secrets, false);
	await context.globalState.update(LAST_STARTUP_CHECK_KEY, Date.now());
	const unavailable = results.filter((result) => result.status === "unavailable");
	if (unavailable.length > 0) {
		const action = await vscode.window.showWarningMessage(
			`Libiao Copilot: ${unavailable.length} model(s) unavailable: ${unavailable.map((result) => result.modelId).join(", ")}`,
			"View Results"
		);
		if (action === "View Results") {
			await checkAllModels(context.secrets, true);
		}
	}
}
