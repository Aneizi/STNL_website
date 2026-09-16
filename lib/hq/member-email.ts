/** HTML and plain text share one code; the logo is supplied as an inline attachment. */
export function memberCodeEmail({ otp, type }: { otp: string; type: string }) {
  if (!/^[0-9]{6}$/.test(otp)) throw new Error("Invalid verification code");
  const changingEmail = type === "change-email";
  const subject = changingEmail ? "Confirm your Superteam NL HQ email" : "Your Superteam NL HQ sign-in code";
  const instruction = changingEmail ? "Enter this code to confirm your email." : "Enter this code to sign in.";
  const notice = changingEmail
    ? "If you did not ask to add this address, you can ignore this email."
    : "If you did not request this code, you can ignore this email.";
  const text = `Your Superteam NL HQ code is ${otp}.\n\n${changingEmail ? "Enter it to confirm this address for your HQ account. " : ""}It expires in 15 minutes. ${notice}`;

  // Tables, inline styles and system fonts keep the message usable in email
  // clients without CSS layout support. The code remains selectable text.
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
    <title>${subject}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#fbf7f0;color:#16130f;font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;">
    <div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Your HQ verification code. Expires in 15 minutes.</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:#fbf7f0;">
      <tr>
        <td align="center" style="padding:32px 12px;">
          <!--[if mso]><table role="presentation" width="520" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:520px;background-color:#ffffff;border:1px solid #e7e3dc;border-radius:12px;border-spacing:0;">
            <tr>
              <td style="padding:0;background-color:#111522;border-radius:12px 12px 0 0;">
                <img src="cid:superteam-nl-logo" alt="Superteam Netherlands" width="520" style="display:block;width:100%;max-width:520px;height:auto;border:0;border-radius:12px 12px 0 0;color:#ffffff;font-size:20px;text-align:center;">
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:32px 24px;">
                <h1 style="margin:0 0 12px;font-family:Arial,Helvetica,sans-serif;font-size:24px;line-height:32px;font-weight:700;color:#16130f;">Your HQ code</h1>
                <p style="margin:0 0 24px;font-size:16px;line-height:24px;color:#57534a;">${instruction}</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border:1px solid #dedad2;border-radius:8px;background-color:#fbfaf7;">
                  <tr>
                    <td align="center" style="padding:24px 12px;font-family:Arial,Helvetica,sans-serif;font-size:40px;line-height:48px;font-weight:700;letter-spacing:6px;white-space:nowrap;color:#16130f;">${otp}</td>
                  </tr>
                </table>
                <p style="margin:20px 0 0;font-size:16px;line-height:24px;color:#57534a;">Expires in 15 minutes.</p>
              </td>
            </tr>
          </table>
          <!--[if mso]></td></tr></table><![endif]-->
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:520px;">
            <tr><td align="center" style="padding:20px 24px 0;font-size:16px;line-height:24px;color:#57534a;">${notice}</td></tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}
