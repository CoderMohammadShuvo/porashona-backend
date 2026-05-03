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
import aiChatRoutes from "./routes/aiChat.js";
import noticeRoutes from "./routes/notices.js";
import libraryRoutes from "./routes/library.js";
import courseRoutes from "./routes/courses.js";


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
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Allow all origins and reflect them back to support credentials:true
  res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  
  // Handle preflight
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// ─── Body parsing ────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ─── Global rate limiter ─────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5000, // Increased for admin dashboard stability
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
app.use("/notices", noticeRoutes);
app.use("/library", libraryRoutes);
app.use("/courses", courseRoutes);
app.use("/api/ai", aiChatRoutes);


app.listen(PORT, "0.0.0.0", () => {
  console.log(`🎓 Porashona Backend running on port ${PORT}`);
});

export default app;
