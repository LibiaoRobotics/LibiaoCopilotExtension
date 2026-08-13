/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module "vscode" {
	// https://github.com/microsoft/vscode/issues/206265

	// System messages are delivered to chat providers with role value 3,
	// although the stable typings only declare User (1) and Assistant (2).
	// `mapRole` in utils.ts relies on this: anything that is neither User
	// nor Assistant is treated as "system".
	export enum LanguageModelChatMessageRole {
		System = 3,
	}
}
