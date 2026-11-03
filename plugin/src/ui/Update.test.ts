import { describe, expect, it, vi } from "vitest";

vi.mock("obsidian", () => ({ apiVersion: "1.9.0", requestUrl: vi.fn() }));
const { newer } = await import("./Update");

describe("Versionsvergleich", () => {
	it("erkennt neuere Versionen", () => {
		expect(newer("0.5.0", "0.4.0")).toBe(true);
		expect(newer("0.10.0", "0.9.3")).toBe(true);
		expect(newer("v1.0.0", "0.99.99")).toBe(true);
		expect(newer("0.4.0", "0.4.0")).toBe(false);
		expect(newer("0.4.0", "0.5.0")).toBe(false);
		expect(newer("0.5.0", "0.5.0-beta.1")).toBe(true);
		expect(newer("0.5.0-beta.1", "0.5.0")).toBe(false);
	});
});
