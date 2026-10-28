/**
 * 企微联动 hook 的路径约定。
 *
 * 只认工作区根目录下的 .github/hooks，不处理多根工作区的其他文件夹，
 * 也不用用户级的 ~/.copilot/hooks —— 那里的 hook 拿不到工作区名，
 * 且 -File 的相对路径会解析失败。
 */
export const WECHAT_NOTIFY_HOOK_DIR = [".github", "hooks"] as const;

export const WECHAT_NOTIFY_JSON_FILE_NAME = "WechatNotify.json";
export const WECHAT_NOTIFY_SCRIPT_FILE_NAME = "WechatNotify.ps1";
export const WECHAT_NOTIFY_CONFIG_FILE_NAME = "WechatNotify.local.psd1";

/** hook 注册文件里写死的相对路径：VS Code 以工作区根目录为 cwd 执行命令 */
export const WECHAT_NOTIFY_SCRIPT_RELATIVE_PATH = ".github/hooks/WechatNotify.ps1";
