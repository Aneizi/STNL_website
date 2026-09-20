import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UpdateTextarea } from "@/components/hq/update-textarea";
import { updateCharacterCount, validUpdateBody } from "@/lib/hq/reporting-body";

describe("update character budget", () => {
  it("ignores spaces, tabs, line breaks and Unicode whitespace", () => {
    expect(updateCharacterCount(" a\tb\nc\r\nd\u00a0e\u2003f\u2028g\ufeff ")).toBe(7);
    expect(validUpdateBody(" \t\n\u00a0\u2003")).toBe(false);
  });

  it("counts Unicode characters once and permits exactly 280", () => {
    expect(updateCharacterCount("🚀 ".repeat(280))).toBe(280);
    expect(validUpdateBody("🚀 \n".repeat(280))).toBe(true);
    expect(validUpdateBody("🚀 \n".repeat(281))).toBe(false);
  });

  it("keeps the whole draft and reports an over-budget paste without a raw maxlength", () => {
    const body = "a ".repeat(281);
    const html = renderToStaticMarkup(createElement(UpdateTextarea, { value: body, readOnly: true, "aria-label": "Your update" }));
    expect(html).toContain(body);
    expect(html).toContain("281/280 characters. Whitespace does not count.");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("aria-describedby=");
    expect(html).not.toContain("maxLength");
    expect(html).not.toContain("maxlength");
  });
});
