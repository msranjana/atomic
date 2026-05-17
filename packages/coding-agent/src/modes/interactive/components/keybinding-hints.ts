/**
 * Utilities for formatting keybinding hints in the UI.
 */

import { getKeybindings, type Keybinding, type KeyId } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.js";

export interface KeyTextFormatOptions {
	/** @deprecated Key labels are always normalized for display. */
	capitalize?: boolean;
}

const MODIFIER_LABELS: Record<string, string> = {
	ctrl: "CTRL",
	control: "CTRL",
	cmd: "CMD",
	command: "CMD",
	shift: "SHIFT",
	alt: process.platform === "darwin" ? "Option" : "ALT",
	meta: "META",
};

const SPECIAL_KEY_LABELS: Record<string, string> = {
	enter: "Enter",
	return: "Return",
	esc: "Escape",
	escape: "Escape",
	space: "Space",
	tab: "Tab",
	backspace: "Backspace",
	delete: "Delete",
	del: "Delete",
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
	home: "Home",
	end: "End",
	pageup: "PageUp",
	pagedown: "PageDown",
};

function formatKeyPart(part: string, _options: KeyTextFormatOptions): string {
	const lower = part.toLowerCase();
	const modifier = MODIFIER_LABELS[lower];
	if (modifier) return modifier;
	const special = SPECIAL_KEY_LABELS[lower];
	if (special) return special;
	if (/^f\d+$/i.test(part)) return part.toUpperCase();
	if (/^[a-z]$/i.test(part)) return part.toUpperCase();
	return part;
}

export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	return key
		.split("/")
		.map((k) =>
			k
				.split("+")
				.map((part) => formatKeyPart(part, options))
				.join("+"),
		)
		.join("/");
}

function formatKeys(keys: KeyId[], options: KeyTextFormatOptions = {}): string {
	if (keys.length === 0) return "";
	return formatKeyText(keys.join("/"), options);
}

export function keyText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding));
}

export function keyDisplayText(keybinding: Keybinding): string {
	return formatKeys(getKeybindings().getKeys(keybinding), { capitalize: true });
}

function formatHintLabel(description: string): string {
	const withoutInfinitive = description.replace(/^to\s+/i, "");
	return withoutInfinitive.replace(/[A-Za-z][A-Za-z'-]*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

export function keyHint(keybinding: Keybinding, description: string): string {
	return theme.fg("dim", keyText(keybinding)) + theme.fg("muted", ` ${formatHintLabel(description)}`);
}

export function rawKeyHint(key: string, description: string): string {
	return theme.fg("dim", formatKeyText(key)) + theme.fg("muted", ` ${formatHintLabel(description)}`);
}
