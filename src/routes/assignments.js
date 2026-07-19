import { Router } from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { supabase } from "../lib/supabase.js";
import { authMiddleware, adminMiddleware } from "../middleware/auth.js";
import { callOpenRouter } from "../lib/aiProvider.js";

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const assignmentsPath = path.join(__dirname, "../data/assignments.json");
const submissionsPath = path.join(__dirname, "../data/submissions.json");

function readJsonFile(filePath, defaultValue = []) {
  try {
    if (!fs.existsSync(filePath)) {
      return defaultValue;
    }
    const data = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(data || "[]");
  } catch (err) {
    console.error(`Error reading file ${filePath}:`, err);
    return defaultValue;
  }
}

function writeJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    console.error(`Error writing file ${filePath}:`, err);
  }
}

// GET all assignments (students) - merges static/created assignments with submissions
router.get("/", authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const assignments = readJsonFile(assignmentsPath);
    const submissions = readJsonFile(submissionsPath);

    // Map submissions for fast lookup
    const userSubmissions = submissions.reduce((acc, sub) => {
      if (sub.userId === userId) {
        acc[sub.assignmentId] = sub;
      }
      return acc;
    }, {});

    const merged = assignments.map((a) => {
      const sub = userSubmissions[a.id];
      if (sub) {
        return {
          ...a,
          status: "completed",
          grade: sub.grade,
          feedback: sub.feedback,
          answer: sub.answer,
        };
      }
      return a;
    });

    res.json(merged);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST to create assignment (admin)
router.post("/", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { title, subject, dueDate } = req.body;
    if (!title || !subject) {
      return res.status(400).json({ error: "Title and subject are required" });
    }

    const assignments = readJsonFile(assignmentsPath);
    const newAssignment = {
      id: "a_" + uuidv4().substring(0, 8),
      title,
      subject,
      dueDate: dueDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      status: "due",
      grade: null,
    };

    assignments.push(newAssignment);
    writeJsonFile(assignmentsPath, assignments);

    res.status(201).json(newAssignment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST to submit assignment (students) -> triggers AI grading
router.post("/submit", authMiddleware, async (req, res) => {
  const { assignmentId, answer } = req.body;
  const userId = req.user.id;

  if (!assignmentId || !answer) {
    return res.status(400).json({ error: "Assignment ID and answer are required" });
  }

  try {
    const assignments = readJsonFile(assignmentsPath);
    const assignment = assignments.find((a) => a.id === assignmentId);
    if (!assignment) {
      return res.status(404).json({ error: "Assignment not found" });
    }

    // Call AI to grade
    const systemPrompt = `You are an expert academic teacher grading high school (HSC) level assignments.
The student has submitted an answer to a Creative Question (CQ) assignment.
Please grade the submission strictly out of 10.0 and provide short constructive feedback.
Respond ONLY with a valid JSON object in the following format:
{
  "grade": <number between 0 and 10.0>,
  "feedback": "<constructive feedback in English or Bangla depending on the language of the prompt or answer>"
}`;

    const promptMessage = `Subject: ${assignment.subject}
Assignment Title: ${assignment.title}
Student's Submitted Answer:
"${answer}"`;

    let grade = 8.0;
    let feedback = "Good effort! Keep practicing to improve.";

    try {
      const aiResponse = await callOpenRouter(systemPrompt, [{ role: "user", content: promptMessage }], {
        temperature: 0.3,
        max_tokens: 300,
      });

      if (aiResponse && aiResponse.content) {
        const text = aiResponse.content.trim();
        // Extract JSON
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (typeof parsed.grade === "number") {
            grade = Math.round(parsed.grade * 10) / 10;
          }
          if (parsed.feedback) {
            feedback = parsed.feedback;
          }
        }
      }
    } catch (aiErr) {
      console.error("AI grading failed, using fallback:", aiErr);
    }

    // Save submission
    const submissions = readJsonFile(submissionsPath);
    const existingIndex = submissions.findIndex((s) => s.userId === userId && s.assignmentId === assignmentId);

    const submissionData = {
      id: "sub_" + uuidv4().substring(0, 8),
      userId,
      assignmentId,
      answer,
      grade,
      feedback,
      submittedAt: new Date().toISOString(),
    };

    if (existingIndex > -1) {
      submissions[existingIndex] = submissionData;
    } else {
      submissions.push(submissionData);
    }
    writeJsonFile(submissionsPath, submissions);

    // Award +25 points via the canonical award_points function (writes to points_ledger)
    try {
      await supabase.rpc("award_points", {
        p_user_id: userId,
        p_reason: "quiz_complete",  // closest matching reason; assignments use quiz_complete (+20 base)
        p_custom_delta: 25,
      });
    } catch (pointsErr) {
      console.error("Failed to award assignment completion points:", pointsErr);
    }


    res.json({
      success: true,
      grade,
      feedback,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
