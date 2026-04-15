import { Resend } from 'resend';
import "dotenv/config";

const resendClient = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

export const sendOTPEmail = async (email, otp) => {
  if (!resendClient) {
    console.warn("Resend API key missing, skipping email send.");
    return;
  }

  try {
    await resendClient.emails.send({
      from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
      to: email,
      subject: 'Verify your Porashona account',
      html: `
        <div style="font-family: sans-serif; padding: 20px; color: #333;">
          <h2>Welcome to Porashona!</h2>
          <p>Please use the following verification code to complete your registration:</p>
          <div style="background: #f4f4f4; padding: 15px; font-size: 24px; font-weight: bold; letter-spacing: 5px; text-align: center; border-radius: 8px;">
            ${otp}
          </div>
          <p>This code will expire in 10 minutes.</p>
          <p>If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    });
    console.log(`OTP email sent to ${email}`);
  } catch (err) {
    console.error("Failed to send email via Resend:", err);
  }
};
