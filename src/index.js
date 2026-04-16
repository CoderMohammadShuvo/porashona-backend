import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import swaggerUi from "swagger-ui-express";
import swaggerJsdoc from "swagger-jsdoc";

import authRoutes from "./routes/auth.js";
import curriculumRoutes from "./routes/curriculum.js";
import chatRoutes from "./routes/chat.js";
import paymentRoutes from "./routes/payment.js";
import videoRoutes from "./routes/video.js";
import ocrRoutes from "./routes/ocr.js";
import guardianRoutes from "./routes/guardian.js";
import leaderboardRoutes from "./routes/leaderboard.js";
import progressRoutes from "./routes/progress.js";
import subscriptionRoutes from "./routes/subscription.js";
import adminRoutes from "./routes/admin.js";

const app = express();
const PORT = process.env.PORT || 3001;

// Swagger definition
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Porashona AI API",
      version: "1.0.0",
      description: "API documentation for Porashona AI EdTech Platform",
    },
    servers: [
      {
        url: "http://localhost:3001",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
  },
  apis: ["./src/routes/*.js"],
};

const swaggerDocs = swaggerJsdoc(swaggerOptions);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// ─── Security middleware ─────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for Swagger UI
}));
app.use(cors({
  origin: [
    "http://localhost:8080",
    "http://localhost:8081",
    "https://porashona-pied.vercel.app"
  ],
  credentials: true,
}));

// ─── Body parsing ────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ─── Global rate limiter ─────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
}));

// ─── Health check ────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "porashona-backend", timestamp: new Date().toISOString() });
});

// ─── Routes ──────────────────────────────────────────────
app.use("/auth", authRoutes);
app.use("/curriculum", curriculumRoutes);
app.use("/chat", chatRoutes);
app.use("/payment", paymentRoutes);
app.use("/video", videoRoutes);
app.use("/ocr", ocrRoutes);
app.use("/guardian", guardianRoutes);
app.use("/leaderboard", leaderboardRoutes);
app.use("/progress", progressRoutes);
app.use("/subscription", subscriptionRoutes);
app.use("/admin", adminRoutes);

// ─── 404 handler ────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// ─── Error handler ───────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({
    error: process.env.NODE_ENV === "production"
      ? "Internal server error"
      : err.message,
  });
});

app.listen(PORT, () => {
  console.log(`\n🎓 Porashona Backend running on http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`   Claude model: ${process.env.CLAUDE_MODEL || "claude-sonnet-4-5"}\n`);
});

export default app;
