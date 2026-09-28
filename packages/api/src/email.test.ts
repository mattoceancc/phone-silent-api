import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  buildConfirmationEmail,
  buildVerificationEmail,
  sendEmail,
} from "./email";

const originalWarn = console.warn;
const warnings: string[] = [];

describe("registration email", () => {
  afterEach(() => {
    console.warn = originalWarn;
    warnings.length = 0;
    delete process.env.RESEND_API_KEY;
  });

  test("verification mail includes a code and a link", () => {
    const built = buildVerificationEmail({
      firstName: "Ada",
      code: "042813",
      url: "http://127.0.0.1:43123/verify-email?token=abc",
    });
    assert.match(built.subject, /verify your email/i);
    assert.match(built.text, /042813/);
    assert.match(built.text, /verify-email\?token=abc/);
    assert.match(built.html, /042813/);
  });

  test("confirmation mail names the account manager and the free quiet zone", () => {
    const built = buildConfirmationEmail({
      firstName: "Ada",
      spaceName: "Main sanctuary",
      active: true,
    });
    assert.match(built.subject, /registered/i);
    assert.match(built.text, /account manager/i);
    assert.match(built.text, /125 ft/);
    assert.match(built.text, /Main sanctuary/);
  });

  test("missing Resend credentials log the message instead of throwing", async () => {
    delete process.env.RESEND_API_KEY;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((item) => String(item)).join(" "));
    };
    const result = await sendEmail(
      {
        to: "ada@example.com",
        subject: "Verify your email for Phone Silent",
        text: "Verification code: 042813",
        html: "<p>042813</p>",
      },
      "verify",
    );
    assert.equal(result.sent, false);
    assert.match(warnings.join("\n"), /email_logged/);
    assert.match(warnings.join("\n"), /RESEND_API_KEY is not set/);
    assert.match(warnings.join("\n"), /042813/);
  });
});
