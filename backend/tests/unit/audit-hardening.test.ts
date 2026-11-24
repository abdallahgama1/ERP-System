import { describe, expect, it } from "vitest";
import { CLIENT_AUDIT_ALLOWED_ACTIONS } from "../../src/routes/audit.ts";
import { sanitizeTemplateHtml } from "../../src/services/print-templates.service.ts";

describe("Audit hardening — print template HTML sanitization & client audit allow-list", () => {
  it("preserves safe formatting tags and safe https/mailto links & images", () => {
    const input =
      '<div align="center"><h2><strong>Acme ERP</strong></h2><p>Thank you!<br>Visit <a href="https://erp.example.com" title="Portal">Portal</a> or <a href="mailto:billing@example.com">Billing</a>.</p><img src="https://cdn.example.com/logo.png" alt="Logo" width="120" height="40"></div>';
    const out = sanitizeTemplateHtml(input);

    expect(out).toContain('<div align="center">');
    expect(out).toContain("<h2><strong>Acme ERP</strong></h2>");
    expect(out).toContain("<br />");
    expect(out).toContain('<a href="https://erp.example.com" title="Portal">Portal</a>');
    expect(out).toContain('<a href="mailto:billing@example.com">Billing</a>');
    expect(out).toContain('<img src="https://cdn.example.com/logo.png" alt="Logo" width="120" height="40" />');
  });

  it("strips script, style, iframe, svg, object, and form elements with their contents", () => {
    const input =
      '<p>Header</p><script>alert(1)</script><style>body{display:none}</style><iframe src="https://evil.test"></iframe><svg onload="alert(2)"><circle /></svg><object data="x"></object><form action="https://evil.test"><input type="text"></form><p>Footer</p>';
    const out = sanitizeTemplateHtml(input);

    expect(out).toBe("<p>Header</p><p>Footer</p>");
    expect(out.toLowerCase()).not.toContain("script");
    expect(out.toLowerCase()).not.toContain("alert");
    expect(out.toLowerCase()).not.toContain("iframe");
    expect(out.toLowerCase()).not.toContain("svg");
    expect(out.toLowerCase()).not.toContain("form");
  });

  it("strips inline event handlers and dangerous javascript:/vbscript:/data: URLs", () => {
    const input = [
      '<p onclick="alert(1)" onmouseover="steal()" style="background:url(javascript:alert(2))">Safe text</p>',
      '<a href="javascript:alert(3)">Bad JS</a>',
      '<a href="  &#106;avascript:alert(4)">Obfuscated JS</a>',
      '<a href="vbscript:msgbox(1)">Bad VB</a>',
      '<a href="data:text/html,<script>alert(5)</script>">Bad Data</a>',
      '<img src="javascript:alert(6)" onerror="alert(7)" alt="bad">',
      '<img src="data:image/svg+xml,<svg onload=alert(8)>" alt="bad-svg">',
    ].join("");

    const out = sanitizeTemplateHtml(input);

    expect(out).toContain("<p>Safe text</p>");
    expect(out.toLowerCase()).not.toContain("onclick");
    expect(out.toLowerCase()).not.toContain("onmouseover");
    expect(out.toLowerCase()).not.toContain("onerror");
    expect(out.toLowerCase()).not.toContain("javascript:");
    expect(out.toLowerCase()).not.toContain("vbscript:");
    expect(out.toLowerCase()).not.toContain("data:");
    expect(out.toLowerCase()).not.toContain("style=");
  });

  it("restricts client-originated audit actions to an explicit non-empty allow-list", () => {
    expect(CLIENT_AUDIT_ALLOWED_ACTIONS.length).toBeGreaterThan(0);
    expect(CLIENT_AUDIT_ALLOWED_ACTIONS).toContain("ui.document_printed");
    expect(CLIENT_AUDIT_ALLOWED_ACTIONS).not.toContain("user.role_updated");
    expect(CLIENT_AUDIT_ALLOWED_ACTIONS).not.toContain("auth.login");
  });
});
