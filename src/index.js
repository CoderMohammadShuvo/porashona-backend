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
import quizRoutes from "./routes/quiz.js";


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
// Robust CORS for Production
app.use(cors({
  origin: (origin, callback) => {
    const allowedOrigins = [
      "http://localhost:8080",
      "http://localhost:8081",
      "https://porashona-pied.vercel.app"
    ];
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith(".vercel.app")) {
      callback(null, true);
    } else {
      callback(null, true);
    }
  },
  credentials: true,
}));

// ─── Body parsing ────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ─── Global rate limiter ─────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
}));

// ─── Health check ────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "porashona-backend" });
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
app.use("/quiz", quizRoutes);


app.listen(PORT, "0.0.0.0", () => {
  console.log(`🎓 Porashona Backend running on port ${PORT}`);
});

export default app;
