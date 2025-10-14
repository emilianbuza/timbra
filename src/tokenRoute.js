import express from "express";
import twilio from "twilio";

const router = express.Router();

router.get("/token", (req, res) => {
  const capability = new twilio.jwt.ClientCapability({
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
  });

  capability.addScope(
    new twilio.jwt.ClientCapability.OutgoingClientScope({
      applicationSid: process.env.TWILIO_TWIML_APP_SID,
    })
  );

  const token = capability.toJwt();
  res.json({ token });
});

export default router;
