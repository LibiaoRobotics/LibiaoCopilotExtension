import type * as vscode from "vscode";
import type { HFModelItem } from "./types";

export type ReasoningEffortPickerValue = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const REASONING_EFFORT_VALUES: readonly ReasoningEffortPickerValue[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export const REASONING_EFFORT_CONFIGURATION_SCHEMA = {
	properties: {
		reasoningEffort: {
			type: "string",
			title: "Reasoning Effort",
			enum: REASONING_EFFORT_VALUES,
			enumItemLabels: ["Minimal", "Low", "Medium", "High", "XHigh", "Max"],
			enumDescriptions: [
				"Smallest reasoning budget",
				"Low reasoning budget",
				"Balanced reasoning budget",
				"High reasoning budget",
				"Very high reasoning budget",
				"Maximum reasoning budget",
			],
			default: "medium",
			group: "navigation",
		},
	},
} as const;

const REASONING_EFFORT_LABELS: Record<ReasoningEffortPickerValue, string> = {
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra High",
	max: "Max",
};

const REASONING_EFFORT_DESCRIPTIONS: Record<ReasoningEffortPickerValue, string> = {
	minimal: "Smallest reasoning budget",
	low: "Low reasoning budget",
	medium: "Balanced reasoning budget",
	high: "High reasoning budget",
	xhigh: "Very high reasoning budget",
	max: "Maximum reasoning budget",
};

function getReasoningEfforts(model: HFModelItem): readonly ReasoningEffortPickerValue[] {
	const configuredValues = model.reasoning_efforts?.filter(isReasoningEffortValue);
	return configuredValues && configuredValues.length > 0 ? [...new Set(configuredValues)] : REASONING_EFFORT_VALUES;
}

function formatTokenCount(value: number): string {
	if (value >= 1000000) {
		return `${Number((value / 1000000).toFixed(1))}M`;
	}
	return `${Math.round(value / 1024)}K`;
}

/**
 * Returns the model's valid selectable context sizes: unique, positive
 * integers within the model's context length, sorted ascending.
 */
export function getValidContextSizes(model: HFModelItem): number[] {
	return [...new Set(model.context_sizes ?? [])]
		.filter((value) => Number.isInteger(value) && value > 0 && value <= (model.context_length ?? value))
		.sort((left, right) => left - right);
}

/**
 * Normalizes a model before it is persisted: when the model declares
 * selectable context sizes but no (or an invalid) default, the largest
 * selectable size is used as the default. This mirrors the fallback
 * applied by `createModelConfigurationSchema` so the VS Code Configure
 * menu has a pre-selected "Default" entry right after the model is added.
 * Models without context sizes are returned unchanged.
 */
export function ensureModelContextDefaults<T extends HFModelItem>(
	model: T
): T & { default_context_size?: number } {
	const validSizes = getValidContextSizes(model);
	if (validSizes.length === 0) {
		return model;
	}
	if (model.default_context_size !== undefined && validSizes.includes(model.default_context_size)) {
		return model;
	}
	return { ...model, default_context_size: validSizes[validSizes.length - 1] };
}

export function createModelConfigurationSchema(model: HFModelItem) {
	const properties: Record<string, unknown> = {};
	if (isReasoningEffortValue(model.reasoning_effort)) {
		const reasoningEfforts = getReasoningEfforts(model);
		const defaultReasoningEffort = reasoningEfforts.includes(model.reasoning_effort)
			? model.reasoning_effort
			: reasoningEfforts[0];
		properties.reasoningEffort = {
			...REASONING_EFFORT_CONFIGURATION_SCHEMA.properties.reasoningEffort,
			enum: reasoningEfforts,
			enumItemLabels: reasoningEfforts.map((value) => REASONING_EFFORT_LABELS[value]),
			enumDescriptions: reasoningEfforts.map((value) => REASONING_EFFORT_DESCRIPTIONS[value]),
			default: defaultReasoningEffort,
		};
	}

	const contextSizes = getValidContextSizes(model);
	if (contextSizes.length > 0) {
		const configuredDefault = model.default_context_size;
		const defaultContextSize = configuredDefault && contextSizes.includes(configuredDefault)
			? configuredDefault
			: contextSizes[contextSizes.length - 1];
		const maxOutputTokens = model.max_completion_tokens ?? model.max_tokens ?? 0;
		const inputSizes = contextSizes.map((value) => Math.max(1, value - maxOutputTokens));
		properties.contextSize = {
			type: "number",
			title: "Context Size",
			enum: inputSizes,
			enumItemLabels: contextSizes.map(formatTokenCount),
			enumDescriptions: contextSizes.map((value) => value === defaultContextSize ? "Default" : "Available context size"),
			default: Math.max(1, defaultContextSize - maxOutputTokens),
			group: "tokens",
		};
	}

	return Object.keys(properties).length > 0 ? { properties } : undefined;
}

export type ModelConfigurationOptions = vscode.ProvideLanguageModelChatResponseOptions & {
	readonly modelConfiguration?: Record<string, unknown>;
	readonly configuration?: Record<string, unknown>;
};

export type ModelPickerChatInformation = vscode.LanguageModelChatInformation & {
	readonly isUserSelectable?: boolean;
	readonly detail?: string;
	readonly tooltip?: string;
	readonly configurationSchema?: ReturnType<typeof createModelConfigurationSchema>;
};

export function isReasoningEffortPickerEnabled(
	model: HFModelItem | undefined
): model is HFModelItem & { reasoning_effort: ReasoningEffortPickerValue } {
	return isReasoningEffortValue(model?.reasoning_effort);
}

export function getConfiguredReasoningEffort(
	options: vscode.ProvideLanguageModelChatResponseOptions | undefined,
	fallback: ReasoningEffortPickerValue = "medium",
	allowedValues: readonly ReasoningEffortPickerValue[] = REASONING_EFFORT_VALUES
): ReasoningEffortPickerValue {
	const modelOptions = options as ModelConfigurationOptions | undefined;
	const configuredEffort =
		modelOptions?.modelConfiguration?.reasoningEffort ?? modelOptions?.configuration?.reasoningEffort;

	if (isReasoningEffortValue(configuredEffort) && allowedValues.includes(configuredEffort)) {
		return configuredEffort;
	}
	return fallback;
}

export function isReasoningEffortValue(value: unknown): value is ReasoningEffortPickerValue {
	return typeof value === "string" && REASONING_EFFORT_VALUES.includes(value as ReasoningEffortPickerValue);
}

/**
 * Returns the context size (input token budget) selected by the user in the
 * VS Code Configure menu for this model, if any.
 *
 * VS Code merges the per-model configuration into
 * `options.modelConfiguration` on every chat request (it does NOT trim the
 * history itself). The stored value is the input-side budget already
 * (context size minus max output tokens, see `createModelConfigurationSchema`),
 * so callers can use it directly as a trimming budget.
 *
 * Returns `undefined` when the user never picked a context size or the value
 * is invalid — callers should then send the history unchanged.
 */
export function getConfiguredContextSize(
	options: vscode.ProvideLanguageModelChatResponseOptions | undefined
): number | undefined {
	const modelOptions = options as ModelConfigurationOptions | undefined;
	const configured = modelOptions?.modelConfiguration?.contextSize ?? modelOptions?.configuration?.contextSize;
	if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
		return Math.floor(configured);
	}
	return undefined;
}
