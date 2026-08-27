const vscode = acquireVsCodeApi();

// 视觉模型图标（码点转义写入避免编码问题）：picture（🖼️ 默认）/ eye（👁️）
const VISION_EMOJI_EYE = "\u{1F441}\uFE0F";
const VISION_EMOJI_PICTURE = "\u{1F5BC}\uFE0F";

// 根据配置值返回对应的 emoji
function getVisionEmoji(icon) {
	return icon === "picture" ? VISION_EMOJI_PICTURE : VISION_EMOJI_EYE;
}

// 模型显示名：vision 字段驱动 emoji 前缀（displayName 数据本身保持纯净）。
// 先剥离旧版图标前缀（👁️/🖼️ 都剥），避免切换图标后出现双前缀。
function formatModelDisplayName(name, vision, icon) {
	if (vision && name) {
		const emoji = getVisionEmoji(icon);
		for (const old of [VISION_EMOJI_EYE, VISION_EMOJI_PICTURE]) {
			if (name.startsWith(old)) {
				name = name.slice(old.length);
				break;
			}
		}
		if (!name.startsWith(emoji)) {
			return emoji + name;
		}
	}
	return name;
}

const state = {
	baseUrl: "",
	apiKey: "",
	delay: 0,
	retry: { enabled: true, max_attempts: 3, interval_ms: 1000, status_codes: [429, 500, 502, 503, 504] },
	contextManagement: "summarize",
	visionIcon: "picture",
	summarizationInstructions: "",
	summarizeMaxTokens: 4000,
	commitModel: "",
	commitModels: [],
	models: [],
	providerKeys: {},
	providerInfo: {},
	modelTestEnabled: false,
	modelTestTesting: false,
	// 模型测试：列表就绪后的全部待测模型（id + 显示名 name）+ 黑名单（未勾选集合）
	modelTestModelIds: [],
	// modelId → 显示名（含视觉图标），测试结果行渲染用
	modelTestNames: {},
	modelTestExclude: [],
	modelTestListLoaded: false,
	// 表格当前是否为可勾选态（加载列表后 true，测试渲染后 false）
	modelTestListEditable: false,
	modelTestDone: 0,
	modelTestTotal: 0,
};

// Store the action to be performed after confirmation
const pendingConfirmations = new Map();

// Global Configuration elements
const baseUrlInput = document.getElementById("baseUrl");
const apiKeyInput = document.getElementById("apiKey");
const delayInput = document.getElementById("delay");
const readFileLinesInput = document.getElementById("readFileLines");
const retryEnabledInput = document.getElementById("retryEnabled");
const maxAttemptsInput = document.getElementById("maxAttempts");
const intervalMsInput = document.getElementById("intervalMs");
const statusCodesInput = document.getElementById("statusCodes");
const contextManagementInput = document.getElementById("contextManagement");
const visionIconInput = document.getElementById("visionIcon");
const summarizationInstructionsInput = document.getElementById("summarizationInstructions");
const summarizeMaxTokensInput = document.getElementById("summarizeMaxTokens");

// Model management elements
const modelTableBody = document.getElementById("modelTableBody");
const modelFormSection = document.getElementById("modelFormSection");
const modelFormTitle = document.getElementById("modelFormTitle");
const modelIdInput = document.getElementById("modelIdInput");
const modelIdDropdown = document.getElementById("modelIdDropdown");
const modelProviderInput = document.getElementById("modelProvider");
const modelDisplayNameInput = document.getElementById("modelDisplayName");
const modelConfigIdInput = document.getElementById("modelConfigId");
const modelBaseUrlInput = document.getElementById("modelBaseUrl");
const modelFamilyInput = document.getElementById("modelFamily");
const modelContextLengthInput = document.getElementById("modelContextLength");
const modelContextSizesInput = document.getElementById("modelContextSizes");
const modelDefaultContextSizeInput = document.getElementById("modelDefaultContextSize");
const modelMaxTokensInput = document.getElementById("modelMaxTokens");
const modelVisionInput = document.getElementById("modelVision");
const modelApiModeInput = document.getElementById("modelApiMode");
const modelTemperatureInput = document.getElementById("modelTemperature");
const modelTopPInput = document.getElementById("modelTopP");
const modelDelayInput = document.getElementById("modelDelay");
const modelTopKInput = document.getElementById("modelTopK");
const modelMinPInput = document.getElementById("modelMinP");
const modelFrequencyPenaltyInput = document.getElementById("modelFrequencyPenalty");
const modelPresencePenaltyInput = document.getElementById("modelPresencePenalty");
const modelRepetitionPenaltyInput = document.getElementById("modelRepetitionPenalty");
const modelReasoningEffortInput = document.getElementById("modelReasoningEffort");
const modelEnableThinkingInput = document.getElementById("modelEnableThinking");
const modelThinkingBudgetInput = document.getElementById("modelThinkingBudget");
const modelIncludeReasoningInput = document.getElementById("modelIncludeReasoning");
const modelMaxCompletionTokensInput = document.getElementById("modelMaxCompletionTokens");
const modelReasoningEnabledInput = document.getElementById("modelReasoningEnabled");
const modelReasoningExcludeInput = document.getElementById("modelReasoningExclude");
const modelReasoningEffortORInput = document.getElementById("modelReasoningEffortOR");
const modelReasoningMaxTokensInput = document.getElementById("modelReasoningMaxTokens");
const modelThinkingTypeInput = document.getElementById("modelThinkingType");
const modelHeadersInput = document.getElementById("modelHeaders");
const modelExtraInput = document.getElementById("modelExtra");
const saveModelBtn = document.getElementById("saveModel");
const cancelModelBtn = document.getElementById("cancelModel");
const toggleAdvancedSettingsBtn = document.getElementById("toggleAdvancedSettings");
const commitModelInput = document.getElementById("commitModel");
const commitLanguageInput = document.getElementById("commitLanguage");
const advancedSettingsContent = document.getElementById("advancedSettingsContent");

// Model test elements
const modelTestSection = document.getElementById("modelTestSection");
const loadModelTestListBtn = document.getElementById("loadModelTestList");
const selectAllModelTestBtn = document.getElementById("selectAllModelTest");
const selectNoneModelTestBtn = document.getElementById("selectNoneModelTest");
const startModelTestBtn = document.getElementById("startModelTest");
const cancelModelTestBtn = document.getElementById("cancelModelTest");
const modelTestProgress = document.getElementById("modelTestProgress");
const modelTestTableBody = document.getElementById("modelTestTableBody");

// Best practices elements
const extensionVersionText = document.getElementById("extensionVersionText");
const openUserMemoryBtn = document.getElementById("openUserMemory");
const applyUserMemoryTemplateBtn = document.getElementById("applyUserMemoryTemplate");
const revealUserMemoryDirBtn = document.getElementById("revealUserMemoryDir");
const userMemoryNameInput = document.getElementById("userMemoryName");
const randomNameBtn = document.getElementById("randomNameBtn");
const updateUserNameBtn = document.getElementById("updateUserNameBtn");
const memoryStatusBadge = document.getElementById("memoryStatusBadge");
const memoryPathDisplay = document.getElementById("memoryPathDisplay");
const customMemoryCard = document.getElementById("customMemoryCard");
const openCustomMemoryBtn = document.getElementById("openCustomMemory");
const deleteCustomMemoryBtn = document.getElementById("deleteCustomMemory");
const customMemoryStatusBadge = document.getElementById("customMemoryStatusBadge");
const customMemoryPathDisplay = document.getElementById("customMemoryPathDisplay");
const orgInstructionsCard = document.getElementById("orgInstructionsCard");
const orgInstructionsStatusBadge = document.getElementById("orgInstructionsStatusBadge");
const orgInstructionsPathDisplay = document.getElementById("orgInstructionsPathDisplay");
const evaluateOrgInstructionsBtn = document.getElementById("evaluateOrgInstructions");
const sanitizeOrgInstructionsBtn = document.getElementById("sanitizeOrgInstructions");
const openOrgInstructionsBtn = document.getElementById("openOrgInstructions");
const evaluateUserMemoryBtn = document.getElementById("evaluateUserMemory");
const evaluateCustomMemoryBtn = document.getElementById("evaluateCustomMemory");
const evaluateCombinedMemoryBtn = document.getElementById("evaluateCombinedMemory");

// PowerShell 7 practice elements
const powershellCard = document.getElementById("powershellCard");
const psStatusBadge = document.getElementById("psStatusBadge");
const psPathDisplay = document.getElementById("psPathDisplay");
const psDescriptionText = document.getElementById("psDescriptionText");
const refreshPsStatusBtn = document.getElementById("refreshPsStatus");
const installPsBtn = document.getElementById("installPsBtn");
const setDefaultTerminalProfileBtn = document.getElementById("setDefaultTerminalProfileBtn");
const openPsDocsBtn = document.getElementById("openPsDocsBtn");

// 100 个趣味昵称池
const NICKNAMES_POOL = [
	"碳基领导",
	"尊贵的碳基生物",
	"硅基驯兽师",
	"Token 批发商",
	"提示词吟唱大哲",
	"算力收割机",
	"幻觉纠偏特派员",
	"上下文管理员",
	"硅基打工人导师",
	"深度学习驯服者",
	"大模型投喂官",
	"算力燃烧者",
	"智能涌现观察员",
	"矩阵乘法指挥官",
	"零样本通灵师",
	"温度系数调谐专家",
	"主分支守护神",
	"代码天尊",
	"技术大腿",
	"东方不报错",
	"热修复真仙",
	"祖传代码继承人",
	"防御性编程大师",
	"抽象设计圣手",
	"架构界扫地僧",
	"重构狂魔",
	"闭包大祭司",
	"递归尽头见真仙",
	"接口定义狂神",
	"并发不锁上人",
	"依赖注入掌门",
	"架构画饼首席厨师",
	"线上救火总指挥",
	"Bug 终结者",
	"生产环境拆弹专家",
	"零点部署狂人",
	"宕机急救室主任",
	"报警风暴过滤器",
	"日志捞针特工",
	"容器编排老法师",
	"内存泄露追凶手",
	"兜底策略总工程师",
	"五个九保活大仙",
	"灰度发布操盘手",
	"容灾备份掌门人",
	"熔断降级舵手",
	"压测终极考验官",
	"物理拔线特战队长",
	"祈祷服务器不崩散仙",
	"Ctrl+C 首席架构师",
	"首席甩锅官",
	"无情需求发射器",
	"优雅摸鱼特级大师",
	"需求粉碎机",
	"敏捷开发摸鱼组长",
	"会议静音观察员",
	"键盘按键延寿专家",
	"咖啡因转化为代码机",
	"需求变更拦截网",
	"准点下班带头人",
	"摸鱼流派创始人",
	"带薪发呆国家队",
	"绩效保卫战神",
	"对齐颗粒度大师",
	"赋能闭环吹号手",
	"工位赛博佛陀",
	"Git 变基狂徒",
	"二进制通灵师",
	"正则表达式终极翻译官",
	"一行代码写天下",
	"跨端适配孤勇者",
	"垃圾回收操盘手",
	"状态机化身",
	"异步并发浪潮儿",
	"栈溢出游泳健将",
	"指针越界捕手",
	"类型体操世界冠军",
	"编译通过即下班",
	"汇编指令低语者",
	"算法复杂度屠夫",
	"零警告强迫症领袖",
	"宏定义造物主",
	"空指针克星",
	"赛博地头蛇",
	"甲方克星",
	"赛博修真老祖",
	"赛博世界执剑人",
	"终极代码审美官",
	"原神启动总顾问",
	"尊贵VIP开发者",
	"顶级白嫖算力专家",
	"人脑外挂终端",
	"灵感永动机",
	"赛博修罗场赢家",
	"全宇宙最强碳基大脑",
	"终端黑客隐士",
	"赛博飞升领航员",
	"降维打击执行官",
	"宇宙级Bug粉碎机",
	"全能架构大宗师",
];

function getRandomNickname(currentName) {
	const pool = NICKNAMES_POOL.filter((n) => n !== currentName);
	return pool[Math.floor(Math.random() * pool.length)] || NICKNAMES_POOL[0];
}

function formatTokenCount(tokens) {
	if (!tokens || tokens <= 0) {
		return "0 tokens";
	}
	if (tokens >= 1000) {
		return `约 ${(tokens / 1000).toFixed(1)}k tokens`;
	}
	return `约 ${tokens} tokens`;
}

function updateOrgInstructionsUi(orgInstructions) {
	if (!orgInstructions || !orgInstructionsCard) {
		if (orgInstructionsCard) {
			orgInstructionsCard.style.display = "none";
		}
		return;
	}
	const { filePath, exists, hasContent, isWritable, lineCount, charCount, tokenCount } = orgInstructions;
	// 动态感知判断条件：文件存在且有内容即展示（是否只读均展示）
	const shouldShow = !!(exists && hasContent);
	orgInstructionsCard.style.display = shouldShow ? "block" : "none";

	if (orgInstructionsPathDisplay) {
		orgInstructionsPathDisplay.textContent = `文件路径: ${filePath || "未知"}`;
	}
	if (orgInstructionsStatusBadge) {
		const charsStr = `${(charCount || 0).toLocaleString()} 字`;
		const tokensStr = formatTokenCount(tokenCount);
		orgInstructionsStatusBadge.className = "memory-status-badge status-missing org-warning-badge";
		orgInstructionsStatusBadge.textContent = `${lineCount} 行 · ${charsStr} · ${tokensStr}`;
	}
}

function updateUserMemoryUi(userMemory, customMemory, orgInstructions) {
	if (userMemory) {
		const { filePath, exists, lineCount, charCount, tokenCount, userName, isTemplateInjected } = userMemory;
		if (memoryPathDisplay) {
			memoryPathDisplay.textContent = `文件路径: ${filePath || "未知"}`;
		}
		if (memoryStatusBadge) {
			if (exists) {
				const charsStr = `${(charCount || 0).toLocaleString()} 字`;
				const tokensStr = formatTokenCount(tokenCount);
				memoryStatusBadge.className = "memory-status-badge status-ready";
				memoryStatusBadge.textContent = `✅ 已就绪 (${lineCount} 行 · ${charsStr} · ${tokensStr})`;
			} else {
				memoryStatusBadge.className = "memory-status-badge status-missing";
				memoryStatusBadge.textContent = `⚠️ 尚未创建（点击下方应用模板）`;
			}
		}
		if (userMemoryNameInput) {
			if (userName) {
				userMemoryNameInput.value = userName;
			} else if (!userMemoryNameInput.value.trim()) {
				// 若记忆中无称呼或文件不存在，输入框不为空，随机选一个填入
				userMemoryNameInput.value = getRandomNickname("");
			}
		}
		if (applyUserMemoryTemplateBtn) {
			applyUserMemoryTemplateBtn.classList.remove("detecting");
			if (isTemplateInjected) {
				applyUserMemoryTemplateBtn.disabled = true;
				applyUserMemoryTemplateBtn.classList.add("injected");
				applyUserMemoryTemplateBtn.textContent = "宇宙最强思想钢印已注入";
			} else {
				applyUserMemoryTemplateBtn.disabled = false;
				applyUserMemoryTemplateBtn.classList.remove("injected");
				applyUserMemoryTemplateBtn.textContent = "🧠 立即注入宇宙最强思想钢印";
			}
		}
	}

	if (customMemory) {
		const { filePath, exists, lineCount, charCount, tokenCount } = customMemory;
		if (customMemoryPathDisplay) {
			customMemoryPathDisplay.textContent = `文件路径: ${filePath || "未知"}`;
		}
		if (customMemoryStatusBadge) {
			if (exists) {
				const charsStr = `${(charCount || 0).toLocaleString()} 字`;
				const tokensStr = formatTokenCount(tokenCount);
				customMemoryStatusBadge.className = "memory-status-badge status-ready";
				customMemoryStatusBadge.textContent = `✅ 已就绪 (${lineCount} 行 · ${charsStr} · ${tokensStr})`;
				customMemoryStatusBadge.style.display = "";
			} else {
				customMemoryStatusBadge.style.display = "none";
			}
		}
	}

	updateOrgInstructionsUi(orgInstructions);

	const userExists = !!(userMemory && userMemory.exists);
	const customExists = !!(customMemory && customMemory.exists);

	if (evaluateUserMemoryBtn) {
		evaluateUserMemoryBtn.style.display = userExists ? "inline-block" : "none";
	}
	if (evaluateCustomMemoryBtn) {
		evaluateCustomMemoryBtn.style.display = customExists ? "inline-block" : "none";
	}
	if (deleteCustomMemoryBtn) {
		deleteCustomMemoryBtn.style.display = customExists ? "inline-block" : "none";
	}
	if (evaluateCombinedMemoryBtn) {
		evaluateCombinedMemoryBtn.style.display = userExists && customExists ? "inline-block" : "none";
	}
	if (openCustomMemoryBtn) {
		openCustomMemoryBtn.textContent = customExists ? "在编辑器中编辑附加记忆" : "创建并编辑附加记忆";
	}
}

function updatePowerShellUi(powershell) {
	if (!powershell) {
		return;
	}
	const { installed, version, executablePath, isDefaultTerminalProfile, platform } = powershell;
	if (psPathDisplay) {
		if (installed) {
			psPathDisplay.textContent = `可执行文件: ${executablePath || "pwsh"}`;
		} else {
			psPathDisplay.textContent = "可执行文件: 未检测到 pwsh（建议立即安装）";
		}
	}
	if (psStatusBadge) {
		if (installed) {
			psStatusBadge.className = "memory-status-badge status-ready";
			psStatusBadge.textContent = `✅ 已就绪 (v${version})`;
		} else {
			psStatusBadge.className = "memory-status-badge status-missing";
			psStatusBadge.textContent = "⚠️ 未安装（当前为系统默认/旧版终端）";
		}
	}
	if (installPsBtn) {
		installPsBtn.style.display = installed ? "none" : "inline-block";
	}
	if (setDefaultTerminalProfileBtn) {
		if (installed && platform === "win32") {
			setDefaultTerminalProfileBtn.style.display = "inline-block";
			if (isDefaultTerminalProfile) {
				setDefaultTerminalProfileBtn.disabled = true;
				setDefaultTerminalProfileBtn.textContent = "✅ 已设为默认终端";
				setDefaultTerminalProfileBtn.title = "VS Code Windows 默认终端 Profile 已配置为 PowerShell";
			} else {
				setDefaultTerminalProfileBtn.disabled = false;
				setDefaultTerminalProfileBtn.textContent = "⚡ 设为 VS Code 默认终端";
				setDefaultTerminalProfileBtn.title = "将 VS Code Windows 默认终端设置为 PowerShell (pwsh)";
			}
		} else {
			setDefaultTerminalProfileBtn.style.display = "none";
		}
	}
}

// Error message element
const modelErrorElement = document.getElementById("modelError");

// Dropdown elements
const dropdownContent = modelIdDropdown.querySelector(".dropdown-content");
const dropdownHeader = modelIdDropdown.querySelector(".dropdown-header");

// Global Configuration save button event listener
const saveGlobalConfig = () => {
	const retry = {
		enabled: retryEnabledInput.checked,
		max_attempts: parseInt(maxAttemptsInput.value) || 3,
		interval_ms: parseInt(intervalMsInput.value) || 1000,
		status_codes: statusCodesInput.value
			? statusCodesInput.value
					.split(",")
					.map((s) => parseInt(s.trim()))
					.filter((n) => !isNaN(n))
			: [],
	};

	vscode.postMessage({
		type: "saveGlobalConfig",
		baseUrl: baseUrlInput.value,
		apiKey: apiKeyInput.value,
		delay: parseInt(delayInput.value) || 0,
		readFileLines: parseInt(readFileLinesInput.value) || 0,
		retry: retry,
		contextManagement: contextManagementInput.value,
		visionIcon: visionIconInput.value,
		summarizationInstructions: summarizationInstructionsInput.value,
		summarizeMaxTokens: parseInt(summarizeMaxTokensInput.value) || 4000,
		commitModel: commitModelInput.value,
		commitLanguage: commitLanguageInput.value,
	});
};

// Top and bottom save buttons both trigger the same save logic
document.getElementById("saveBaseTop").addEventListener("click", saveGlobalConfig);
document.getElementById("saveBase").addEventListener("click", saveGlobalConfig);

// Open the VS Code settings.json file
const resetModelsBtn = document.getElementById("resetModels");
if (resetModelsBtn) {
	resetModelsBtn.addEventListener("click", () => {
		vscode.postMessage({ type: "resetModels" });
	});
}

// Open the VS Code settings.json file
document.getElementById("openSettings").addEventListener("click", () => {
	vscode.postMessage({ type: "openSettings" });
});

// Best practices event listeners
if (randomNameBtn) {
	randomNameBtn.addEventListener("click", () => {
		const current = userMemoryNameInput ? userMemoryNameInput.value.trim() : "";
		if (userMemoryNameInput) {
			userMemoryNameInput.value = getRandomNickname(current);
			userMemoryNameInput.focus();
			const len = userMemoryNameInput.value.length;
			userMemoryNameInput.setSelectionRange(len, len);
		}
	});
}

if (userMemoryNameInput && updateUserNameBtn) {
	userMemoryNameInput.addEventListener("keydown", (e) => {
		if (e.key === "Enter") {
			e.preventDefault();
			updateUserNameBtn.click();
		}
	});
}

if (updateUserNameBtn) {
	updateUserNameBtn.addEventListener("click", () => {
		const targetName = userMemoryNameInput ? userMemoryNameInput.value.trim() : "";
		vscode.postMessage({
			type: "updateUserMemoryName",
			userName: targetName,
		});
	});
}

if (openUserMemoryBtn) {
	openUserMemoryBtn.addEventListener("click", () => {
		vscode.postMessage({
			type: "openUserMemoryFile",
			userName: userMemoryNameInput ? userMemoryNameInput.value.trim() : "",
		});
	});
}

if (openCustomMemoryBtn) {
	openCustomMemoryBtn.addEventListener("click", () => {
		vscode.postMessage({ type: "openCustomMemoryFile" });
	});
}

if (deleteCustomMemoryBtn) {
	deleteCustomMemoryBtn.addEventListener("click", () => {
		vscode.postMessage({ type: "deleteCustomMemory" });
	});
}

if (evaluateUserMemoryBtn) {
	evaluateUserMemoryBtn.addEventListener("click", () => {
		vscode.postMessage({ type: "evaluateUserMemory" });
	});
}

if (evaluateCustomMemoryBtn) {
	evaluateCustomMemoryBtn.addEventListener("click", () => {
		vscode.postMessage({ type: "evaluateCustomMemory" });
	});
}

if (evaluateCombinedMemoryBtn) {
	evaluateCombinedMemoryBtn.addEventListener("click", () => {
		vscode.postMessage({ type: "evaluateCombinedMemory" });
	});
}

if (sanitizeOrgInstructionsBtn) {
	sanitizeOrgInstructionsBtn.addEventListener("click", () => {
		const confirmId = "sanitizeOrgInstructions_" + Date.now();
		pendingConfirmations.set(confirmId, {
			action: () => {
				vscode.postMessage({ type: "sanitizeOrgInstructions" });
			},
		});
		vscode.postMessage({
			type: "requestConfirm",
			id: confirmId,
			message: "确定要狙杀并排除组织指令干扰吗？\n\n该操作将清空 default.instructions.md 的内容并将其锁定为只读属性，防止后续 GitHub 登录时重新覆写污染。",
			action: "sanitizeOrgInstructions",
		});
	});
}

if (openOrgInstructionsBtn) {
	openOrgInstructionsBtn.addEventListener("click", () => {
		vscode.postMessage({ type: "openOrgInstructionsFile" });
	});
}

if (evaluateOrgInstructionsBtn) {
	evaluateOrgInstructionsBtn.addEventListener("click", () => {
		vscode.postMessage({ type: "evaluateOrgInstructions" });
	});
}

if (applyUserMemoryTemplateBtn) {
	applyUserMemoryTemplateBtn.addEventListener("click", () => {
		const targetName = userMemoryNameInput ? userMemoryNameInput.value.trim() : "";
		vscode.postMessage({
			type: "applyUserMemoryTemplate",
			userName: targetName,
		});
	});
}

if (revealUserMemoryDirBtn) {
	revealUserMemoryDirBtn.addEventListener("click", () => {
		vscode.postMessage({ type: "revealUserMemoryFolder" });
	});
}

if (refreshPsStatusBtn) {
	refreshPsStatusBtn.addEventListener("click", () => {
		if (psStatusBadge) {
			psStatusBadge.className = "memory-status-badge";
			psStatusBadge.textContent = "检测中...";
		}
		vscode.postMessage({ type: "getPowerShellStatus" });
	});
}

if (installPsBtn) {
	installPsBtn.addEventListener("click", () => {
		vscode.postMessage({ type: "installPowerShell" });
	});
}

if (setDefaultTerminalProfileBtn) {
	setDefaultTerminalProfileBtn.addEventListener("click", () => {
		vscode.postMessage({ type: "setDefaultTerminalProfile" });
	});
}

if (openPsDocsBtn) {
	openPsDocsBtn.addEventListener("click", () => {
		vscode.postMessage({ type: "openPowerShellDocs" });
	});
}

const handleRefresh = () => {
	// Hide the model form if it's visible
	if (modelFormSection.style.display !== "none") {
		modelFormSection.style.display = "none";
		resetModelForm();
	}
	vscode.postMessage({ type: "requestInit" });
};

// Export and Import buttons event listeners
document.getElementById("exportConfig").addEventListener("click", () => {
	vscode.postMessage({ type: "exportConfig" });
});

document.getElementById("importConfig").addEventListener("click", () => {
	vscode.postMessage({ type: "importConfig" });
});

// Refresh buttons event listeners
document.getElementById("refreshGlobalConfig").addEventListener("click", handleRefresh);
document.getElementById("refreshModels").addEventListener("click", handleRefresh);

// Add Model button event listeners
document.getElementById("addModel").addEventListener("click", () => {
	// Show the model form
	modelFormSection.style.display = "block";
	modelFormTitle.textContent = "新增模型";
	// Reset form
	resetModelForm();
});

// Provider dropdown change event listener for auto-fill
modelProviderInput.addEventListener("change", () => {
	const selectedProvider = modelProviderInput.value;
	if (selectedProvider && state.providerInfo[selectedProvider]) {
		// Auto-fill BaseURL and apiMode from provider info
		modelBaseUrlInput.value = state.providerInfo[selectedProvider].baseUrl;
		modelApiModeInput.value = state.providerInfo[selectedProvider].apiMode;

		// Use headers from provider info
		const headers = state.providerInfo[selectedProvider].headers;
		modelHeadersInput.value = headers ? JSON.stringify(headers, null, 2) : "";

		// Request to fetch remote models for the selected provider
		vscode.postMessage({
			type: "fetchModels",
			baseUrl: state.providerInfo[selectedProvider].baseUrl || state.baseUrl,
			apiKey: state.providerKeys[selectedProvider] || state.apiKey,
			apiMode: state.providerInfo[selectedProvider].apiMode || modelApiModeInput.value || "openai",
			headers,
		});
	}
});

// Auto-fill Default Context Size with the largest selectable size while it is empty
modelContextSizesInput.addEventListener("input", () => {
	if (modelDefaultContextSizeInput.value) {
		return;
	}
	const sizes = modelContextSizesInput.value
		.split(",")
		.map((value) => parseInt(value.trim()))
		.filter((value) => !isNaN(value) && value > 0);
	if (sizes.length > 0) {
		modelDefaultContextSizeInput.value = Math.max(...sizes);
	}
});

// Toggle advanced settings
toggleAdvancedSettingsBtn.addEventListener("click", () => {
	const isCurrentlyVisible = advancedSettingsContent.style.display !== "none";
	advancedSettingsContent.style.display = isCurrentlyVisible ? "none" : "block";
	toggleAdvancedSettingsBtn.textContent = isCurrentlyVisible ? "显示高级设置" : "隐藏高级设置";
});

// Save Model button event listener
saveModelBtn.addEventListener("click", () => {
	const modelData = collectModelFormData();
	if (!validateModelData(modelData)) {
		return;
	}

	// For updates, ensure the model ID remains unchanged
	const isEditing = modelIdInput.hasAttribute("data-editing");
	if (isEditing) {
		// Remove helper attributes from the model data before sending
		let originalModelId = modelData.originalModelId;
		let originalConfigId = modelData.originalConfigId;
		delete modelData.originalModelId;
		delete modelData.originalConfigId;

		vscode.postMessage({
			type: "updateModel",
			model: modelData,
			originalModelId: originalModelId,
			originalConfigId: originalConfigId,
		});
	} else {
		vscode.postMessage({
			type: "addModel",
			model: modelData,
		});
	}

	// Hide the form and reset it
	modelFormSection.style.display = "none";
	resetModelForm();
});

// Cancel Model button event listener
cancelModelBtn.addEventListener("click", () => {
	// Hide the form and reset it
	modelFormSection.style.display = "none";
	resetModelForm();
});

// Model test button event listeners
loadModelTestListBtn.addEventListener("click", () => {
	// 拉取验证后的模型列表（不启动测试）
	modelTestProgress.textContent = "正在加载模型列表…";
	vscode.postMessage({ type: "fetchTestModels" });
});

selectAllModelTestBtn.addEventListener("click", () => {
	// 全选：清空黑名单并持久化
	state.modelTestExclude = [];
	refreshModelTestCheckboxes();
	persistModelTestExclude();
	updateModelTestUi();
});

selectNoneModelTestBtn.addEventListener("click", () => {
	// 全不选：全部加入黑名单并持久化
	state.modelTestExclude = [...state.modelTestModelIds];
	refreshModelTestCheckboxes();
	persistModelTestExclude();
	updateModelTestUi();
});

startModelTestBtn.addEventListener("click", () => {
	// 只测勾选的模型
	const selected = state.modelTestModelIds.filter((id) => !state.modelTestExclude.includes(id));
	if (selected.length === 0) {
		modelTestProgress.textContent = "请先勾选至少一个模型。";
		return;
	}
	// 清空上次结果重新开始
	modelTestTableBody.innerHTML = "";
	state.modelTestTesting = true;
	state.modelTestDone = 0;
	state.modelTestTotal = selected.length;
	updateModelTestUi();
	vscode.postMessage({ type: "testSelectedModels", modelIds: selected });
});

cancelModelTestBtn.addEventListener("click", () => {
	vscode.postMessage({ type: "cancelModelTest" });
});

window.addEventListener("message", (event) => {
	const message = event.data;

	switch (message.type) {
		case "init":
			const {
				baseUrl,
				apiKey,
				delay,
				readFileLines,
				retry,
				contextManagement,
				visionIcon,
				summarizationInstructions,
				summarizeMaxTokens,
				commitModel,
				commitModels,
				models,
				providerKeys,
				commitLanguage,
				modelTestEnabled,
				userMemory,
			} = message.payload;
			state.baseUrl = baseUrl;
			state.apiKey = apiKey;
			state.delay = delay || 0;
			state.readFileLines = readFileLines || 0;
			state.retry = retry || {
				enabled: true,
				max_attempts: 3,
				interval_ms: 1000,
				status_codes: [],
			};
			state.contextManagement = contextManagement || "summarize";
			state.visionIcon = visionIcon || "picture";
			state.summarizationInstructions = summarizationInstructions || "";
			state.summarizeMaxTokens = summarizeMaxTokens || 4000;
			state.models = models || [];
			state.commitModels = commitModels || [];
			state.commitModel = commitModel || "";
			state.providerKeys = providerKeys || {};
			state.modelTestEnabled = !!modelTestEnabled;

			// 更新模型测试区显示：仅当隐藏参数启用时展示
			modelTestSection.style.display = state.modelTestEnabled ? "block" : "none";

			// Update base configuration
			baseUrlInput.value = baseUrl || "";
			apiKeyInput.value = apiKey || "";
			delayInput.value = state.delay;
			readFileLinesInput.value = message.payload.readFileLines || 0;
			retryEnabledInput.checked = state.retry.enabled !== false;
			maxAttemptsInput.value = state.retry.max_attempts || 3;
			intervalMsInput.value = state.retry.interval_ms || 1000;
			statusCodesInput.value = state.retry.status_codes ? state.retry.status_codes.join(",") : "";
			contextManagementInput.value = state.contextManagement;
			visionIconInput.value = state.visionIcon;
			summarizationInstructionsInput.value = state.summarizationInstructions;
			summarizeMaxTokensInput.value = state.summarizeMaxTokens;

			// Populate commit model dropdown and select current commit model
			populateCommitModelDropdown();
			commitModelInput.value = state.commitModel || "";
			commitLanguageInput.value = commitLanguage;

			if (extensionVersionText && message.payload.version) {
				const v = message.payload.version;
				const cleanV = v.startsWith("v") ? v : `v${v}`;
				const buildDate = message.payload.buildDate;
				extensionVersionText.textContent = buildDate ? `${cleanV} (${buildDate})` : cleanV;
			}

			// Render user memory status
			updateUserMemoryUi(userMemory, message.payload.customMemory, message.payload.orgInstructions);

			// Render powershell status
			updatePowerShellUi(message.payload.powershell);

			// Render model management
			renderModels();
			break;
		case "userMemoryStatus":
			updateUserMemoryUi(message.userMemory, message.customMemory, message.orgInstructions);
			break;
		case "powershellStatus":
			updatePowerShellUi(message.powershell);
			break;
		case "modelsFetched":
			// Handle the response from fetchModels
			populateModelIdDropdown(message.models);
			break;
		case "modelsFetchError":
			// Handle error from fetchModels
			dropdownHeader.textContent = "拉取模型失败";
			dropdownContent.innerHTML = `<div class="dropdown-option error">拉取模型失败，请查看开发者控制台获取详细信息。</div>`;
			console.error("[oaicopilot] Failed to fetch models:", message.error);
			break;
		case "confirmResponse":
			// Handle confirmation responses
			const pendingAction = pendingConfirmations.get(message.id);
			if (pendingAction && message.confirmed) {
				if (pendingAction.action) {
					pendingAction.action();
				}
				// Clean up the pending confirmation
				pendingConfirmations.delete(message.id);
			} else if (pendingAction) {
				// Clean up the pending confirmation even if not confirmed
				pendingConfirmations.delete(message.id);
			}
			break;
		case "modelTestListLoaded":
			// 列表就绪：渲染全部待测模型（可勾选），黑名单里的默认不勾选
			state.modelTestModelIds = Array.isArray(message.models) ? message.models.map((m) => m.id) : [];
			state.modelTestNames = {};
			for (const m of Array.isArray(message.models) ? message.models : []) {
				state.modelTestNames[m.id] = m.name;
			}
			state.modelTestExclude = Array.isArray(message.exclude) ? message.exclude : [];
			state.modelTestListLoaded = true;
			state.modelTestListEditable = true;
			renderModelTestList();
			modelTestProgress.textContent = `共 ${state.modelTestModelIds.length} 个模型，勾选后点击「开始测试」。`;
			updateModelTestUi();
			break;
		case "modelTestListError":
			modelTestProgress.textContent = `加载模型列表失败：${message.error}`;
			updateModelTestUi();
			break;
		case "modelTestStatus":
			state.modelTestTesting = !!message.testing;
			if (!message.testing) {
				// 测试结束（含取消）：仍在等待/测试中的行统一标记为"已取消"
				finalizePendingModelTestRows();
				updateModelTestUi();
			}
			break;
		case "modelTestStarted":
			// 本次实际测试的模型（勾选子集）：一次性渲染行（等待态）
			state.modelTestTotal = message.models.length;
			state.modelTestDone = 0;
			state.modelTestListEditable = false;
			renderModelTestRows(message.models);
			modelTestProgress.textContent = `开始测试 ${message.models.length} 个模型…`;
			updateModelTestUi();
			break;
		case "modelTestRowRunning":
			// 单个模型开工：对应行从"等待"切到"测试中"
			setModelTestRowStatus(message.modelId, "running");
			break;
		case "modelTestResult":
			state.modelTestDone = message.done;
			state.modelTestTotal = message.total;
			updateModelTestRow(message.result);
			modelTestProgress.textContent = `已完成 ${message.done}/${message.total || message.done}`;
			updateModelTestUi();
			break;
		case "modelTestDone":
			state.modelTestTesting = false;
			modelTestProgress.textContent = `测试完成：${message.succeeded}/${message.tested} 个模型可用`;
			finalizePendingModelTestRows();
			updateModelTestUi();
			break;
	}
});

	/** 渲染可勾选的模型列表（加载列表后调用） */
	function renderModelTestList() {
		modelTestTableBody.innerHTML = "";
		for (const modelId of state.modelTestModelIds) {
			const excluded = state.modelTestExclude.includes(modelId);
			const tr = document.createElement("tr");
			tr.dataset.modelId = modelId;
			tr.innerHTML = `
				<td class="test-select-col"><input type="checkbox" class="model-test-checkbox" ${excluded ? "" : "checked"}></td>
				<td>${escapeHtml(state.modelTestNames[modelId] || modelId)}</td>
				<td class="test-waiting">${excluded ? "— 已排除" : "⏳ 待测"}</td>
				<td></td>
				<td></td>
				<td></td>
				<td></td>
				<td></td>`;
			modelTestTableBody.appendChild(tr);
		}
		// 绑定勾选事件：变化即持久化
		modelTestTableBody.querySelectorAll(".model-test-checkbox").forEach((cb) => {
			cb.addEventListener("change", () => {
				const tr = cb.closest("tr");
				const modelId = tr.dataset.modelId;
				if (cb.checked) {
					state.modelTestExclude = state.modelTestExclude.filter((id) => id !== modelId);
					const statusCell = tr.children[2];
					statusCell.className = "test-waiting";
					statusCell.textContent = "⏳ 待测";
				} else {
					state.modelTestExclude.push(modelId);
					const statusCell = tr.children[2];
					statusCell.className = "test-excluded";
					statusCell.textContent = "— 已排除";
				}
				persistModelTestExclude();
				updateModelTestUi();
			});
		});
	}

	/** 勾选状态变化后刷新所有 checkbox（全选/全不选用） */
	function refreshModelTestCheckboxes() {
		for (const cb of modelTestTableBody.querySelectorAll(".model-test-checkbox")) {
			// 只刷勾选态行（可交互的 checkbox），跳过测试结果行（disabled，避免覆盖结果状态）
			if (cb.disabled) {
				continue;
			}
			const tr = cb.closest("tr");
			const modelId = tr.dataset.modelId;
			const excluded = state.modelTestExclude.includes(modelId);
			cb.checked = !excluded;
			const statusCell = tr.children[2];
			statusCell.className = excluded ? "test-excluded" : "test-waiting";
			statusCell.textContent = excluded ? "— 已排除" : "⏳ 待测";
		}
	}

	/** 把当前黑名单持久化到 settings（隐藏参数 modelTestExclude） */
	function persistModelTestExclude() {
		vscode.postMessage({ type: "updateModelTestExclude", exclude: [...state.modelTestExclude] });
	}

	function updateModelTestUi() {
		const hasList = state.modelTestListLoaded && state.modelTestModelIds.length > 0;
		const selectedCount = state.modelTestModelIds.filter((id) => !state.modelTestExclude.includes(id)).length;
		// 测试中禁用所有编辑操作；勾选编辑仅在「可勾选态」可用（测试结果态需先重新加载列表）
		const editable = state.modelTestListEditable && !state.modelTestTesting;
		loadModelTestListBtn.disabled = state.modelTestTesting;
		selectAllModelTestBtn.disabled = !editable || !hasList;
		selectNoneModelTestBtn.disabled = !editable || !hasList;
		startModelTestBtn.disabled = state.modelTestTesting || selectedCount === 0;
		startModelTestBtn.textContent = `开始测试（${selectedCount}）`;
		cancelModelTestBtn.disabled = !state.modelTestTesting;
	}

	/** 点击测试后：一次性渲染实际待测模型行（等待态），让用户立刻看到待测清单 */
	function renderModelTestRows(models) {
		modelTestTableBody.innerHTML = "";
		for (const m of models) {
			const tr = document.createElement("tr");
			tr.dataset.modelId = m.id;
			tr.innerHTML = `
				<td class="test-select-col"><input type="checkbox" class="model-test-checkbox" checked disabled></td>
				<td>${escapeHtml(m.name || m.id)}</td>
				<td class="test-waiting">⏳ 等待</td>
				<td></td>
				<td></td>
				<td></td>
				<td></td>
				<td></td>`;
			modelTestTableBody.appendChild(tr);
		}
	}

	function findModelTestRow(modelId) {
		return modelTestTableBody.querySelector(`tr[data-model-id="${CSS.escape(modelId)}"]`);
	}

	/** 单个模型开工：状态列切到"测试中" */
	function setModelTestRowStatus(modelId, status) {
		const tr = findModelTestRow(modelId);
		if (!tr) {
			return;
		}
		const statusCell = tr.children[2];
		if (status === "running") {
			statusCell.className = "test-running";
			statusCell.textContent = "⌛ 测试中…";
		}
	}

	/** 毫秒转秒显示（生成耗时列，保留 2 位小数） */
	function formatSeconds(ms) {
		if (ms === undefined || ms === null || ms === "") {
			return "";
		}
		return (ms / 1000).toFixed(2);
	}

	/** 结果回报：原地更新对应行（并发下结果乱序到达，按 modelId 定位） */
	function updateModelTestRow(result) {
		const tr = findModelTestRow(result.modelId);
		if (!tr) {
			// 兜底：找不到预渲染行（如 __empty__/__error__ 等异常占位），直接追加
			appendModelTestRow(result);
			return;
		}
		if (result.ok) {
			const tpsDisplay = result.tps !== undefined && result.tps !== null ? Math.round(result.tps) : "";
			tr.innerHTML = `
				<td class="test-select-col"></td>
				<td>${escapeHtml(result.name || result.modelId)}</td>
				<td class="test-ok">✓ 可用</td>
				<td>${result.ttftMs ?? ""}</td>
				<td>${formatSeconds(result.generateMs)}</td>
				<td>${result.outputTokens ?? ""}</td>
				<td class="test-tps">${tpsDisplay}</td>
				<td></td>`;
		} else {
			tr.innerHTML = `
				<td class="test-select-col"></td>
				<td>${escapeHtml(result.name || result.modelId)}</td>
				<td class="test-fail">✗ 失败</td>
				<td></td>
				<td></td>
				<td></td>
				<td></td>
				<td class="test-error">${escapeHtml(result.error || "")}</td>`;
		}
	}

	/** 兜底追加行（异常占位结果：__empty__/__error__） */
	function appendModelTestRow(result) {
		const tr = document.createElement("tr");
		if (result.ok) {
			const tpsDisplay = result.tps !== undefined && result.tps !== null ? Math.round(result.tps) : "";
			tr.innerHTML = `
				<td class="test-select-col"></td>
				<td>${escapeHtml(result.name || result.modelId)}</td>
				<td class="test-ok">✓ 可用</td>
				<td>${result.ttftMs ?? ""}</td>
				<td>${formatSeconds(result.generateMs)}</td>
				<td>${result.outputTokens ?? ""}</td>
				<td class="test-tps">${tpsDisplay}</td>
				<td></td>`;
		} else {
			tr.innerHTML = `
				<td class="test-select-col"></td>
				<td>${escapeHtml(result.name || result.modelId)}</td>
				<td class="test-fail">✗ 失败</td>
				<td></td>
				<td></td>
				<td></td>
				<td></td>
				<td class="test-error">${escapeHtml(result.error || "")}</td>`;
		}
		modelTestTableBody.appendChild(tr);
	}

	/** 测试结束（含取消）：仍在等待/测试中的行标记为"已取消"，避免状态悬空 */
	function finalizePendingModelTestRows() {
		for (const tr of modelTestTableBody.querySelectorAll("tr")) {
			const statusCell = tr.children[2];
			if (!statusCell) {
				continue;
			}
			if (statusCell.classList.contains("test-waiting") || statusCell.classList.contains("test-running")) {
				statusCell.className = "test-cancelled";
				statusCell.textContent = "— 已取消";
			}
		}
	}

	function escapeHtml(value) {
		return String(value)
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;");
	}

	function renderModels() {
		const models = state.models
			.filter((m) => !m.id.startsWith("__provider__"))
			.sort((a, b) => a.id.localeCompare(b.id));
		if (!models.length) {
			modelTableBody.innerHTML = '<tr><td colspan="11" class="no-data">无模型</td></tr>';
			return;
		}

		const rows = models
			.map((model) => {
			return `
			<tr data-model-id="${model.id}${model.configId ? "::" + model.configId : ""}">
				<td>${model.id}</td>
				<td>${model.owned_by}</td>
				<td>${formatModelDisplayName(model.displayName || "", model.vision, state.visionIcon)}</td>
				<td>${model.configId || ""}</td>
				<td>${model.context_length || ""}</td>
				<td>${model.max_tokens || model.max_completion_tokens || ""}</td>
				<td>${model.vision ? "是" : ""}</td>
				<td>${model.temperature !== undefined && model.temperature !== null ? model.temperature : ""}</td>
				<td>${model.top_p !== undefined && model.top_p !== null ? model.top_p : ""}</td>
				<td>${model.delay || ""}</td>
				<td class="action-buttons">
					<button class="update-model-btn" data-model-id="${model.id}${model.configId ? "::" + model.configId : ""}">编辑</button>
					<button class="delete-model-btn danger" data-model-id="${model.id}${model.configId ? "::" + model.configId : ""}">删除</button>
				</td>
			</tr>`;
		})
		.join("");

	modelTableBody.innerHTML = rows;

	// Add event listeners for model rows
	document.querySelectorAll(".update-model-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const modelId = event.target.getAttribute("data-model-id");
			// Find the model in state
			const parsedModelId = modelId.includes("::")
				? { baseId: modelId.split("::")[0], configId: modelId.split("::")[1] }
				: { baseId: modelId, configId: null };

			const model = state.models.find(
				(m) =>
					m.id === parsedModelId.baseId &&
					((parsedModelId.configId && m.configId === parsedModelId.configId) ||
						(!parsedModelId.configId && !m.configId))
			);

			if (model) {
				// Show the model form in edit mode
				modelFormSection.style.display = "block";
				modelFormTitle.textContent = `编辑模型：${modelId}`;
				populateModelForm(model);
			}
		});
	});

	document.querySelectorAll(".delete-model-btn").forEach((btn) => {
		btn.addEventListener("click", (event) => {
			const modelId = event.target.getAttribute("data-model-id");
			const confirmId = "deleteModel_" + Date.now();

			// Store the action to be performed after confirmation
			pendingConfirmations.set(confirmId, {
				action: () => vscode.postMessage({ type: "deleteModel", modelId: modelId }),
			});

			vscode.postMessage({
				type: "requestConfirm",
				id: confirmId,
				message: `确定要删除模型 ${modelId} 吗？`,
				action: "deleteModel",
			});
		});
	});
}

// Reset model form
function resetModelForm() {
	// Clear any error message
	showModelError("");

	modelIdInput.value = "";
	modelProviderInput.value = "";
	modelDisplayNameInput.value = "";
	modelConfigIdInput.value = "";
	modelBaseUrlInput.value = "";
	modelFamilyInput.value = "";
	modelContextLengthInput.value = 128000;
	modelContextSizesInput.value = "";
	modelDefaultContextSizeInput.value = "";
	modelMaxTokensInput.value = 4096;
	modelVisionInput.value = "";
	modelApiModeInput.value = "openai";
	modelTemperatureInput.value = 0;
	modelTopPInput.value = "";
	modelDelayInput.value = "";
	modelTopKInput.value = "";
	modelMinPInput.value = "";
	modelFrequencyPenaltyInput.value = "";
	modelPresencePenaltyInput.value = "";
	modelRepetitionPenaltyInput.value = "";
	modelReasoningEffortInput.value = "";
	modelEnableThinkingInput.value = "";
	modelThinkingBudgetInput.value = "";
	modelIncludeReasoningInput.value = "";
	modelMaxCompletionTokensInput.value = "";
	modelReasoningEnabledInput.value = "";
	modelReasoningExcludeInput.value = "";
	modelReasoningEffortORInput.value = "";
	modelReasoningMaxTokensInput.value = "";
	modelThinkingTypeInput.value = "";
	modelHeadersInput.value = "";
	modelExtraInput.value = "";
	advancedSettingsContent.style.display = "none";
	toggleAdvancedSettingsBtn.textContent = "显示高级设置";
	// Remove editing attribute
	modelIdInput.removeAttribute("data-editing");
	modelIdInput.removeAttribute("data-original-id");
	modelIdInput.removeAttribute("data-original-configId");
	// disbale fields when form is reset
	modelBaseUrlInput.disabled = true;
	modelApiModeInput.disabled = true;
	// Clear dropdown options
	dropdownContent.innerHTML = "";
}

// Collect model form data
function collectModelFormData() {
	const isEditing = modelIdInput.hasAttribute("data-editing");
	const contextSizes = modelContextSizesInput.value
		? modelContextSizesInput.value.split(",").map((value) => parseInt(value.trim()))
		: undefined;
	const validContextSizes = (contextSizes ?? []).filter((value) => !isNaN(value) && value > 0);
	const defaultContextSize = modelDefaultContextSizeInput.value
		? parseInt(modelDefaultContextSizeInput.value)
		: undefined;

	return {
		id: modelIdInput.value.trim(),
		owned_by: modelProviderInput.value.trim(),
		displayName: modelDisplayNameInput.value.trim() || undefined,
		configId: modelConfigIdInput.value.trim() || undefined,
		baseUrl: modelBaseUrlInput.value.trim() || undefined,
		family: modelFamilyInput.value.trim() || undefined,
		context_length: modelContextLengthInput.value ? parseInt(modelContextLengthInput.value) : undefined,
		context_sizes: contextSizes,
		// Fall back to the largest selectable size so a model added without an
		// explicit default still gets a pre-selected entry in the Configure menu.
		default_context_size:
			defaultContextSize ??
			(validContextSizes.length > 0 ? Math.max(...validContextSizes) : undefined),
		max_tokens: modelMaxTokensInput.value ? parseInt(modelMaxTokensInput.value) : undefined,
		vision: modelVisionInput.value ? modelVisionInput.value === "true" : undefined,
		apiMode: modelApiModeInput.value || undefined,
		temperature: modelTemperatureInput.value !== "" ? parseFloat(modelTemperatureInput.value) : undefined,
		top_p: modelTopPInput.value !== "" ? parseFloat(modelTopPInput.value) : undefined,
		delay: modelDelayInput.value ? parseInt(modelDelayInput.value) : undefined,
		top_k: modelTopKInput.value ? parseInt(modelTopKInput.value) : undefined,
		min_p: modelMinPInput.value !== "" ? parseFloat(modelMinPInput.value) : undefined,
		frequency_penalty:
			modelFrequencyPenaltyInput.value !== "" ? parseFloat(modelFrequencyPenaltyInput.value) : undefined,
		presence_penalty: modelPresencePenaltyInput.value !== "" ? parseFloat(modelPresencePenaltyInput.value) : undefined,
		repetition_penalty:
			modelRepetitionPenaltyInput.value !== "" ? parseFloat(modelRepetitionPenaltyInput.value) : undefined,
		reasoning_effort: modelReasoningEffortInput.value || undefined,
		enable_thinking: modelEnableThinkingInput.value ? modelEnableThinkingInput.value === "true" : undefined,
		thinking_budget: modelThinkingBudgetInput.value ? parseInt(modelThinkingBudgetInput.value) : undefined,
		include_reasoning_in_request: modelIncludeReasoningInput.value
			? modelIncludeReasoningInput.value === "true"
			: undefined,
		max_completion_tokens: modelMaxCompletionTokensInput.value
			? parseInt(modelMaxCompletionTokensInput.value)
			: undefined,
		// Build reasoning configuration object
		reasoning: buildReasoningConfig(),
		// Build thinking configuration object
		thinking: buildThinkingConfig(),
		// Parse headers and extra JSON
		headers: parseJsonField(modelHeadersInput.value),
		extra: parseJsonField(modelExtraInput.value),
		// Include original modelId and configId for update operations
		originalModelId: isEditing ? modelIdInput.getAttribute("data-original-id") : undefined,
		originalConfigId: isEditing ? modelIdInput.getAttribute("data-original-configId") : undefined,
	};
}

// Build reasoning configuration object from form fields
function buildReasoningConfig() {
	const enabled = modelReasoningEnabledInput.value ? modelReasoningEnabledInput.value === "true" : undefined;
	const effort = modelReasoningEffortORInput.value || undefined;
	const exclude = modelReasoningExcludeInput.value ? modelReasoningExcludeInput.value === "true" : undefined;
	const maxTokens = modelReasoningMaxTokensInput.value ? parseInt(modelReasoningMaxTokensInput.value) : undefined;

	// Only return an object if at least one field has a value
	if (enabled !== undefined || effort !== undefined || exclude !== undefined || maxTokens !== undefined) {
		return {
			enabled,
			effort,
			exclude,
			max_tokens: maxTokens,
		};
	}
	return undefined;
}

// Build thinking configuration object from form fields
function buildThinkingConfig() {
	const type = modelThinkingTypeInput.value || undefined;

	if (type !== undefined) {
		return { type };
	}
	return undefined;
}

// Parse JSON field, return undefined if empty or invalid
function parseJsonField(value) {
	if (!value || value.trim() === "") {
		return undefined;
	}
	try {
		return JSON.parse(value.trim());
	} catch (error) {
		// ignore invalid JSON
		return undefined;
	}
}

// Show error message in the UI
function showModelError(message) {
	if (modelErrorElement) {
		modelErrorElement.textContent = message;
		modelErrorElement.style.display = message ? "block" : "none";

		// Scroll to error message if it's visible
		if (message) {
			modelErrorElement.scrollIntoView({ behavior: "smooth", block: "nearest" });
		}
	}
}

// Validate model data
function validateModelData(modelData) {
	// Clear any previous error
	showModelError("");

	if (!modelData.id) {
		showModelError("模型 ID 为必填项。");
		return false;
	}
	if (!modelData.owned_by) {
		showModelError("供应商 ID 为必填项。");
		return false;
	}

	// Validate modelId and configId Uniqueness
	const isEditing = modelIdInput.hasAttribute("data-editing");
	const hasDuplicate = state.models
		.filter((m) => {
			if (isEditing) {
				const isOrigin =
					m.id === modelData.originalModelId &&
					((modelData.originalConfigId && m.configId === modelData.originalConfigId) ||
						(!modelData.originalConfigId && !m.configId));
				return !isOrigin;
			}
			return true;
		})
		.some((m) => {
			return (
				m.id === modelData.id &&
				((modelData.configId && m.configId === modelData.configId) || (!modelData.configId && !m.configId))
			);
		});

	if (hasDuplicate) {
		showModelError(
			`模型 ID="${modelData.id}"${modelData.configId ? ` 且配置 ID="${modelData.configId}"` : ""} 已存在。模型 ID 与配置 ID 的组合必须唯一。`
		);
		return false;
	}

	// Validate numeric fields if provided
	if (modelData.context_length !== undefined && (isNaN(modelData.context_length) || modelData.context_length <= 0)) {
		showModelError("上下文长度必须为正数。");
		return false;
	}
	if (modelData.context_sizes?.some((value) => isNaN(value) || value <= 0)) {
		showModelError("上下文档位只能包含正整数。");
		return false;
	}
	if (modelData.context_sizes?.some((value) => value > modelData.context_length)) {
		showModelError("上下文档位不能超过上下文长度。");
		return false;
	}
	if (
		modelData.default_context_size !== undefined &&
		!modelData.context_sizes?.includes(modelData.default_context_size)
	) {
		showModelError("默认上下文大小必须包含在上下文档位中。");
		return false;
	}
	if (modelData.max_tokens !== undefined && (isNaN(modelData.max_tokens) || modelData.max_tokens <= 0)) {
		showModelError("最大 Token 数必须为正数。");
		return false;
	}
	if (
		modelData.max_completion_tokens !== undefined &&
		(isNaN(modelData.max_completion_tokens) || modelData.max_completion_tokens <= 0)
	) {
		showModelError("最大完成 Token 数必须为正数。");
		return false;
	}
	// Prevent both max_tokens and max_completion_tokens from being set simultaneously
	if (modelData.max_tokens !== undefined && modelData.max_completion_tokens !== undefined) {
		showModelError("不能同时设置 'max_tokens' 和 'max_completion_tokens'，请只使用 'max_completion_tokens'。");
		return false;
	}
	if (
		modelData.temperature !== undefined &&
		(isNaN(modelData.temperature) || modelData.temperature < 0 || modelData.temperature > 2)
	) {
		showModelError("Temperature 必须介于 0 和 2 之间。");
		return false;
	}
	if (modelData.top_p !== undefined && (isNaN(modelData.top_p) || modelData.top_p < 0 || modelData.top_p > 1)) {
		showModelError("Top P 必须介于 0 和 1 之间。");
		return false;
	}
	if (modelData.delay !== undefined && (isNaN(modelData.delay) || modelData.delay < 0)) {
		showModelError("延迟必须为非负数。");
		return false;
	}

	// Validate JSON fields
	if (modelData.headers && typeof modelData.headers !== "object") {
		showModelError("自定义请求头必须是合法的 JSON 对象。");
		return false;
	}
	if (modelData.extra && typeof modelData.extra !== "object") {
		showModelError("附加参数必须是合法的 JSON 对象。");
		return false;
	}

	return true;
}

// Function to populate the model ID datalist
function populateModelIdDropdown(models) {
	const modelsArray = Array.from(models || []);

	// Clear existing options
	dropdownContent.innerHTML = "";

	if (!modelsArray.length) {
		dropdownHeader.textContent = "无可用模型";
		return;
	}

	dropdownHeader.textContent = `选择模型（${modelsArray.length} 个可用）`;

	// Create option elements
	modelsArray.forEach((model) => {
		const option = document.createElement("div");
		option.className = "dropdown-option";
		option.textContent = model.id;
		option.dataset.modelId = model.id;

		// Add click event
		option.addEventListener("click", () => {
			modelIdInput.value = model.id;
			hideDropdown();

			// Remove selection from all options
			dropdownContent.querySelectorAll(".dropdown-option").forEach((opt) => {
				opt.classList.remove("selected");
			});

			// Add selection to clicked option
			option.classList.add("selected");
		});

		dropdownContent.appendChild(option);
	});
}

// Function to populate the commit model dropdown
function populateCommitModelDropdown() {
	// Clear existing options except the first "None" option
	while (commitModelInput.children.length > 1) {
		commitModelInput.removeChild(commitModelInput.lastChild);
	}

	// state.commitModels 已在后端按官方推荐白名单及优先级排序好
	const commitCompatibleModels = (state.commitModels || []).filter(
		(model) => !model.id.startsWith("__provider__")
	);

	// Add options for compatible models in recommended order
	commitCompatibleModels.forEach((model) => {
		const option = document.createElement("option");
		const fullModelId = `${model.id}${model.configId ? "::" + model.configId : ""}`;
		option.value = fullModelId;
		option.textContent = formatModelDisplayName(model.displayName || "", model.vision, state.visionIcon) || fullModelId;
		commitModelInput.appendChild(option);
	});
}

// Dropdown visibility functions
function showDropdown() {
	if (dropdownContent.children.length > 0) {
		modelIdDropdown.classList.add("show");
	}
}

function hideDropdown() {
	modelIdDropdown.classList.remove("show");
}

function toggleDropdown() {
	if (modelIdDropdown.classList.contains("show")) {
		hideDropdown();
	} else {
		showDropdown();
	}
}

// Populate model form with existing data
function populateModelForm(model) {
	// Clear any error message
	showModelError("");

	// Store the original modelId and configId for update operations
	modelIdInput.setAttribute("data-original-id", model.id || "");
	modelIdInput.setAttribute("data-original-configId", model.configId || "");

	modelIdInput.value = model.id || "";

	// Ensure the provider is in the dropdown options
	const currentProvider = model.owned_by || "";
	const providerExists = Array.from(modelProviderInput.options).some((option) => option.value === currentProvider);

	if (!providerExists && currentProvider) {
		// Add the provider to the dropdown if it doesn't exist
		const newOption = document.createElement("option");
		newOption.value = currentProvider;
		newOption.textContent = currentProvider;
		modelProviderInput.appendChild(newOption);
	}

	const providerInfo = state.providerInfo[currentProvider];
	const fetchBaseUrl = model.baseUrl || state.baseUrl;
	const fetchApiKey = state.providerKeys[currentProvider] || state.apiKey;
	const fetchApiMode = providerInfo?.apiMode || model.apiMode || modelApiModeInput.value || "openai";

	// Request to fetch remote models for the selected provider
	vscode.postMessage({
		type: "fetchModels",
		baseUrl: fetchBaseUrl,
		apiKey: fetchApiKey,
		apiMode: fetchApiMode,
		headers: model.headers,
	});

	modelProviderInput.value = currentProvider;
	modelDisplayNameInput.value = model.displayName || "";
	modelConfigIdInput.value = model.configId || "";
	modelBaseUrlInput.value = model.baseUrl || "";
	modelFamilyInput.value = model.family || "";
	modelContextLengthInput.value = model.context_length || "";
	modelContextSizesInput.value = model.context_sizes?.join(", ") || "";
	modelDefaultContextSizeInput.value = model.default_context_size || "";
	modelMaxTokensInput.value = model.max_tokens || "";
	modelVisionInput.value = model.vision !== undefined ? String(model.vision) : "";
	modelApiModeInput.value = model.apiMode || "openai";
	modelTemperatureInput.value = model.temperature !== undefined && model.temperature !== null ? model.temperature : "";
	modelTopPInput.value = model.top_p !== undefined && model.top_p !== null ? model.top_p : "";
	modelDelayInput.value = model.delay || "";
	modelTopKInput.value = model.top_k || "";
	modelMinPInput.value = model.min_p || "";
	modelFrequencyPenaltyInput.value = model.frequency_penalty || "";
	modelPresencePenaltyInput.value = model.presence_penalty || "";
	modelRepetitionPenaltyInput.value = model.repetition_penalty || "";
	modelReasoningEffortInput.value = model.reasoning_effort || "";
	modelEnableThinkingInput.value = model.enable_thinking !== undefined ? String(model.enable_thinking) : "";
	modelThinkingBudgetInput.value = model.thinking_budget || "";
	modelIncludeReasoningInput.value =
		model.include_reasoning_in_request !== undefined ? String(model.include_reasoning_in_request) : "";
	modelMaxCompletionTokensInput.value = model.max_completion_tokens || "";
	// Populate reasoning configuration
	if (model.reasoning) {
		modelReasoningEnabledInput.value = model.reasoning.enabled !== undefined ? String(model.reasoning.enabled) : "";
		modelReasoningEffortORInput.value = model.reasoning.effort || "";
		modelReasoningExcludeInput.value = model.reasoning.exclude !== undefined ? String(model.reasoning.exclude) : "";
		modelReasoningMaxTokensInput.value = model.reasoning.max_tokens || "";
	}
	// Populate thinking configuration
	if (model.thinking) {
		modelThinkingTypeInput.value = model.thinking.type || "";
	}
	// Populate headers and extra
	modelHeadersInput.value = model.headers ? JSON.stringify(model.headers, null, 2) : "";
	modelExtraInput.value = model.extra ? JSON.stringify(model.extra, null, 2) : "";
	// Mark that we're in editing mode by setting an attribute
	modelIdInput.setAttribute("data-editing", "true");
	// Disable BaseURL and apiMode fields when editing
	modelBaseUrlInput.disabled = true;
	modelApiModeInput.disabled = true;
}

// Initialize dropdown event listeners
function initDropdownEvents() {
	// Show dropdown on focus
	modelIdInput.addEventListener("focus", () => {
		if (dropdownContent.children.length > 0) {
			showDropdown();
		}
	});

	// Hide dropdown when clicking outside
	document.addEventListener("click", (event) => {
		if (!modelIdDropdown.contains(event.target) && event.target !== modelIdInput) {
			hideDropdown();
		}
	});

	// Handle keyboard navigation
	modelIdInput.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			hideDropdown();
		} else if (event.key === "ArrowDown" && modelIdDropdown.classList.contains("show")) {
			event.preventDefault();
			const options = dropdownContent.querySelectorAll(".dropdown-option");
			if (options.length > 0) {
				const firstOption = options[0];
				firstOption.focus();
				firstOption.classList.add("selected");
			}
		}
	});

	// Allow user to type freely
	modelIdInput.addEventListener("input", () => {
		// Clear selection when user types
		dropdownContent.querySelectorAll(".dropdown-option").forEach((opt) => {
			opt.classList.remove("selected");
		});

		// Filter options based on input
		const searchTerm = modelIdInput.value.toLowerCase();
		const options = dropdownContent.querySelectorAll(".dropdown-option");

		options.forEach((option) => {
			const modelId = option.dataset.modelId.toLowerCase();
			if (modelId.includes(searchTerm)) {
				option.style.display = "block";
			} else {
				option.style.display = "none";
			}
		});

		// Update header with filtered count
		const visibleCount = Array.from(options).filter((opt) => opt.style.display !== "none").length;
		dropdownHeader.textContent = `Select Model (${visibleCount} matching)`;
	});
}

// Initialize dropdown events
initDropdownEvents();

vscode.postMessage({ type: "requestInit" });
