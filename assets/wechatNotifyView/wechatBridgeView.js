/* global acquireVsCodeApi */
// 「企微对话」面板区。与 wechatNotifyView.js 各管一段 DOM，互不读写对方的元素。
// 整体包在 IIFE 里：两个脚本共享同一个全局作用域，而下面的名字（vscode、applyState、
// flushAutoSave、AUTO_SAVE_DELAY_MS…）与前一个脚本全部重名，裸写会让整个文件 SyntaxError。
// 函数体保持不缩进，避免为了包一层而改动每一行。
// acquireVsCodeApi 每个 webview 只允许调用一次，优先复用前一个脚本挂出来的实例。
(function () {
const vscode = window.__libiaoCopilotApi || acquireVsCodeApi();

const DEFAULT_TIMEOUT_SECONDS = 900;
const AUTO_SAVE_DELAY_MS = 500;

const bridge = {
	section: document.getElementById("bridgeSection"),
	saveHint: document.getElementById("bridgeSaveHint"),
	statusNotice: document.getElementById("bridgeStatusNotice"),
	statusText: document.getElementById("bridgeStatusText"),
	reconnect: document.getElementById("bridgeReconnect"),
	disconnect: document.getElementById("bridgeDisconnect"),
	rejectedNotice: document.getElementById("bridgeRejectedNotice"),
	rejectedText: document.getElementById("bridgeRejectedText"),
	authorize: document.getElementById("bridgeAuthorize"),
	authNotice: document.getElementById("bridgeAuthNotice"),
	authText: document.getElementById("bridgeAuthText"),
	authorizeWechat: document.getElementById("bridgeAuthorizeWechat"),
	revoke: document.getElementById("bridgeRevoke"),
	enabled: document.getElementById("bridgeEnabled"),
	botId: document.getElementById("bridgeBotId"),
	secret: document.getElementById("bridgeSecret"),
	saveCredentials: document.getElementById("bridgeSaveCredentials"),
	allowedUser: document.getElementById("bridgeAllowedUser"),
	injectTarget: document.getElementById("bridgeInjectTarget"),
	timeoutSeconds: document.getElementById("bridgeTimeoutSeconds"),
	timeoutHuman: document.getElementById("bridgeTimeoutHuman"),
	groupNotify: document.getElementById("bridgeGroupNotify"),
	resetSession: document.getElementById("bridgeResetSession"),
	activityNotice: document.getElementById("bridgeActivityNotice"),
	activityText: document.getElementById("bridgeActivityText"),
};

let autoSaveTimer;
let lastSavedSignature = "";

function parseTimeout(input) {
	const value = Number.parseInt(input.value, 10);
	return Number.isFinite(value) ? value : DEFAULT_TIMEOUT_SECONDS;
}

// 自动保存回推状态时不覆盖正在编辑的输入框，否则光标会被拽走
function setInputValue(element, value) {
	if (document.activeElement === element) {
		return;
	}
	element.value = value;
}

function collectBridgeSettings() {
	return {
		injectTarget: bridge.injectTarget.value === "dedicated" ? "dedicated" : "current",
		allowedUserId: bridge.allowedUser.value.trim(),
		respondTimeoutSeconds: parseTimeout(bridge.timeoutSeconds),
		notifyGroupForBridgeTurns: bridge.groupNotify.checked,
	};
}

function showSaveHint(text) {
	bridge.saveHint.textContent = text;
	bridge.saveHint.classList.toggle("visible", Boolean(text));
}

function formatDuration(seconds) {
	const total = Math.max(0, Math.trunc(seconds));
	if (total === 0) {
		return "0 秒";
	}
	let rest = total;
	const parts = [];
	for (const [size, label] of [[3600, "小时"], [60, "分钟"], [1, "秒"]]) {
		const value = Math.floor(rest / size);
		rest -= value * size;
		if (value > 0) {
			parts.push(value + " " + label);
		}
	}
	return parts.join(" ");
}

function scheduleAutoSave() {
	clearTimeout(autoSaveTimer);
	autoSaveTimer = setTimeout(flushAutoSave, AUTO_SAVE_DELAY_MS);
}

function flushAutoSave() {
	clearTimeout(autoSaveTimer);
	autoSaveTimer = undefined;
	const settings = collectBridgeSettings();
	const signature = JSON.stringify(settings);
	if (signature === lastSavedSignature) {
		return;
	}
	lastSavedSignature = signature;
	showSaveHint("保存中…");
	vscode.postMessage({ type: "bridgeSave", settings });
}

function describeStatus(state) {
	switch (state.connection) {
		case "subscribed":
			return "已连接，等待企微消息";
		case "connecting":
			return "正在连接…";
		case "closed":
			return "连接已断开，正在重试";
		case "failed":
			return "连接失败";
		case "kicked":
			return "已被其他连接接管";
		default:
			return state.enabled ? "未连接" : "已关闭";
	}
}

function statusTone(state) {
	if (state.connection === "subscribed") {
		return "bridge-status-ok";
	}
	if (state.connection === "failed" || state.connection === "kicked") {
		return "bridge-status-error";
	}
	return "bridge-status-warn";
}

function renderStatus(state) {
	const parts = [describeStatus(state)];
	if (state.holder && state.connection !== "subscribed") {
		parts.push("（该机器人当前由「" + state.holder + "」占用）");
	}
	if (state.connectionDetail) {
		parts.push(" — " + state.connectionDetail);
	}
	if (state.queueDepth > 0) {
		parts.push(" · 排队 " + state.queueDepth + " 条");
	}
	bridge.statusText.textContent = parts.join(" ");
	bridge.statusNotice.classList.remove("bridge-status-ok", "bridge-status-warn", "bridge-status-error");
	bridge.statusNotice.classList.add(statusTone(state));

	bridge.reconnect.disabled = false;
	bridge.disconnect.disabled = state.connection === "idle" && !state.enabled;
}

function renderActivity(state) {
	const activity = state.lastActivity;
	if (!activity) {
		bridge.activityNotice.hidden = true;
		return;
	}
	const time = new Date(activity.at).toLocaleTimeString();
	const prefix = activity.ok ? "✅" : "❌";
	const detail = activity.detail ? "（" + activity.detail + "）" : "";
	bridge.activityText.textContent =
		prefix + " " + time + " · " + activity.prompt + detail;
	bridge.activityNotice.hidden = false;
}

function renderRejected(state) {
	const rejected = state.lastRejectedUserId;
	bridge.rejectedNotice.hidden = !rejected || rejected === state.allowedUserId;
	bridge.rejectedText.textContent = rejected ? "收到来自 " + rejected + " 的消息，已忽略。" : "";
}

function describeAuthRequest(request) {
	switch (request.phase) {
		case "pending":
			return "授权卡片已发出，等待企微确认（有效至 " + new Date(request.expiresAt).toLocaleTimeString() + "）";
		case "accepted":
			return request.detail || "企微里已点「允许」";
		case "rejected":
			return request.detail || "企微里已点「拒绝」";
		case "expired":
			return "授权卡片已过期，可重新发起";
		default:
			return request.detail ? "发起失败：" + request.detail : "发起失败";
	}
}

function renderAuth(state) {
	const authorized = Boolean(state.allowedUserId);
	const parts = [];
	if (authorized) {
		parts.push("已授权 " + state.allowedUserId);
	} else if (state.lastSeenUserId) {
		parts.push(
			"未授权任何人；卡片将发给最近给机器人发过消息的 " +
				state.lastSeenUserId +
				"，确认这是你本人才点"
		);
	} else {
		parts.push("未授权任何人");
	}
	if (state.authRequest) {
		parts.push(describeAuthRequest(state.authRequest));
	}
	bridge.authText.textContent = parts.join(" · ");
	bridge.authNotice.classList.remove("bridge-status-ok", "bridge-status-warn", "bridge-status-error");
	bridge.authNotice.classList.add(authorized ? "bridge-status-ok" : "bridge-status-warn");
	bridge.revoke.disabled = !authorized;
	// 长连接没就绪，或者上一张卡片还在等人点，就不允许再发
	bridge.authorizeWechat.disabled =
		state.connection !== "subscribed" || Boolean(state.authRequest && state.authRequest.phase === "pending");
}

function applyState(state) {
	setInputValue(bridge.botId, state.botId);
	setInputValue(bridge.allowedUser, state.allowedUserId);
	setInputValue(bridge.timeoutSeconds, state.respondTimeoutSeconds);
	if (document.activeElement !== bridge.injectTarget) {
		bridge.injectTarget.value = state.injectTarget;
	}
	if (document.activeElement !== bridge.enabled) {
		bridge.enabled.checked = state.enabled;
	}
	if (document.activeElement !== bridge.groupNotify) {
		bridge.groupNotify.checked = state.notifyGroupForBridgeTurns;
	}
	bridge.secret.placeholder = state.hasSecret ? "已保存，留空表示不修改" : "必填";
	bridge.timeoutHuman.textContent = "= " + formatDuration(state.respondTimeoutSeconds);
	lastSavedSignature = JSON.stringify({
		injectTarget: state.injectTarget,
		allowedUserId: state.allowedUserId,
		respondTimeoutSeconds: state.respondTimeoutSeconds,
		notifyGroupForBridgeTurns: state.notifyGroupForBridgeTurns,
	});
	renderStatus(state);
	renderActivity(state);
	renderRejected(state);
	renderAuth(state);
}

bridge.enabled.addEventListener("change", () => {
	vscode.postMessage({ type: "bridgeSetEnabled", enabled: bridge.enabled.checked });
});

bridge.injectTarget.addEventListener("change", flushAutoSave);
bridge.allowedUser.addEventListener("input", scheduleAutoSave);
bridge.allowedUser.addEventListener("change", flushAutoSave);
bridge.timeoutSeconds.addEventListener("input", () => {
	bridge.timeoutHuman.textContent = "= " + formatDuration(parseTimeout(bridge.timeoutSeconds));
	scheduleAutoSave();
});
bridge.timeoutSeconds.addEventListener("change", flushAutoSave);
bridge.groupNotify.addEventListener("change", flushAutoSave);

bridge.saveCredentials.addEventListener("click", () => {
	// Secret 只在点这里时才提交：自动保存会把明文密钥反复推过消息通道
	bridge.saveCredentials.disabled = true;
	bridge.saveCredentials.textContent = "保存中…";
	showSaveHint("保存中…");
	vscode.postMessage({
		type: "bridgeCredentials",
		botId: bridge.botId.value.trim(),
		secret: bridge.secret.value,
	});
});

bridge.reconnect.addEventListener("click", () => {
	bridge.reconnect.disabled = true;
	vscode.postMessage({ type: "bridgeReconnect" });
});

bridge.disconnect.addEventListener("click", () => {
	vscode.postMessage({ type: "bridgeDisconnect" });
});

bridge.resetSession.addEventListener("click", () => {
	vscode.postMessage({ type: "bridgeResetSession" });
});

bridge.authorize.addEventListener("click", () => {
	vscode.postMessage({ type: "bridgeAuthorize" });
});

bridge.authorizeWechat.addEventListener("click", () => {
	bridge.authorizeWechat.disabled = true;
	vscode.postMessage({ type: "bridgeAuthorizeFromWechat" });
});

bridge.revoke.addEventListener("click", () => {
	bridge.revoke.disabled = true;
	vscode.postMessage({ type: "bridgeRevokeAuthorization" });
});

window.addEventListener("message", (event) => {
	const message = event.data;
	if (message.type !== "bridgeState") {
		return;
	}
	applyState(message.state);
	// Secret 保存后要清空输入框，避免明文停在界面上
	if (document.activeElement !== bridge.secret) {
		bridge.secret.value = "";
	}
	bridge.saveCredentials.disabled = false;
	bridge.saveCredentials.textContent = "保存凭证并连接";
	showSaveHint("");
});

vscode.postMessage({ type: "bridgeRequestState" });
})();
