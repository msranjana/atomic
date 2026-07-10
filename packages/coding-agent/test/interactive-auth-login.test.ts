import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import "../src/modes/interactive/interactive-auth-login.ts";

beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("interactive API-key login persistence failures", () => {
	it("surfaces the save error without reporting authentication success", async () => {
		vi.spyOn(LoginDialogComponent.prototype, "showPrompt").mockResolvedValue("secret-key");
		const saveError = new Error("auth.json is read-only");
		const showError = vi.fn();
		const showStatus = vi.fn();
		const completeProviderAuthentication = vi.fn();
		const editor = {};
		const harness = {
			session: {
				model: undefined,
				modelRegistry: {
					authStorage: { set: vi.fn(() => { throw saveError; }) },
				},
			},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor,
			showError,
			showStatus,
			completeProviderAuthentication,
		};

		const showApiKeyLoginDialog = InteractiveModeBase.prototype.showApiKeyLoginDialog as (
			this: typeof harness,
			providerId: string,
			providerName: string,
		) => Promise<void>;
		await showApiKeyLoginDialog.call(harness, "example", "Example Provider");

		expect(harness.session.modelRegistry.authStorage.set).toHaveBeenCalledWith("example", {
			type: "api_key",
			key: "secret-key",
		});
		expect(completeProviderAuthentication).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
		expect(showError).toHaveBeenCalledWith(
			"Failed to save API key for Example Provider: auth.json is read-only",
		);
		expect(harness.editorContainer.addChild).toHaveBeenLastCalledWith(editor);
	});
});
