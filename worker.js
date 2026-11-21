// Syllabus Grade Calculator — AI relay for Cloudflare Workers (free plan).
// Keeps your Gemini API key on Cloudflare, so visitors to your site never need one.
// It only accepts syllabus text/page images and always uses its own fixed prompt,
// so nobody can use it as a general-purpose free AI endpoint.
//
// Settings (Worker → Settings → Variables and Secrets):
//   GEMINI_KEY       (Secret, required)  your key from aistudio.google.com
//   ALLOWED_ORIGINS  (Text, recommended) your site address(es), comma separated,
//                    e.g. https://yourname.github.io,https://grades.netlify.app
//   GEMINI_MODEL     (Text, optional)    default: gemini-flash-latest
//   DAILY_LIMIT      (Text, optional)    uploads per visitor per day, default 25
// Optional binding (Worker → Settings → Bindings → KV namespace):
//   LIMITS           enables the per-visitor daily limit

const INSTR = `You read university course syllabi and extract their grading scheme. Reply with ONLY a JSON object, no prose:
{"courses":[{"code":"CHEM 101","title":"General Chemistry I","isLab":false,
 "components":[{"name":"Quizzes","kind":"quiz","weight":10,"count":10,"drop":2}],
 "boundaries":[{"grade":"A","min":90},{"grade":"B+","min":87}]}]}
Rules:
- components: every graded category. weight = percent of the final grade (numbers, should total ~100). If the syllabus gives points, convert to percent of total points. List exams separately when weighted separately (e.g. Midterm 1, Midterm 2, Final), or as one component with count when they share one weight.
- kind: "lab" for laboratory grade / lab reports / experiments; "quiz" for quizzes; "exam" for midterms, tests, finals, practicals; "assignment" for homework, problem sets, worksheets; "project"; "participation" for attendance/participation/clickers; else "other".
- count: number of individual graded items in that category if stated or clearly inferable (e.g. "10 weekly quizzes", a lab schedule listing 9 experiments); otherwise null.
- drop: how many lowest scores are dropped, if stated; otherwise 0.
- boundaries: letter-grade cutoffs as the minimum percent, highest first, including +/- grades if listed. For a range like "B 80-89.9" use 80. If no scale is given, return [].
- isLab: true if this syllabus is for a laboratory course or lab section (code ending in L, title containing Lab/Laboratory, or the document is a lab manual/schedule). For a lab syllabus, components describe how the lab grade itself is made up, and count is the number of labs/experiments/reports.
- code: course code like "PHYS 201L" if present, else a short name. title: course title.
- If the document holds several separate course syllabi, return one entry for each.
- If the document is not a course syllabus, return {"courses":[]}.`;

const MAX_BODY = 8 * 1024 * 1024;   // bytes
const MAX_TEXT = 80000;              // characters
const MAX_IMAGES = 4;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim().replace(/\/$/, "")).filter(Boolean);
    const originOk = !allowed.length || allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allowed.length ? (originOk ? origin : allowed[0]) : "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const reply = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method === "GET") return reply(200, { ok: true, service: "syllabus-grade-calculator relay" });
    if (request.method !== "POST") return reply(405, { error: "Use POST." });
    if (!originOk) return reply(403, { error: "This reader only works on its own site." });
    if (!env.GEMINI_KEY) return reply(500, { error: "The site owner hasn't added a Gemini key to the relay yet." });
    if (+(request.headers.get("Content-Length") || 0) > MAX_BODY) return reply(413, { error: "That file is too large. Try a smaller PDF or fewer pages." });

    let body;
    try { body = await request.json(); } catch { return reply(400, { error: "Bad request." }); }
    const text = String(body.text || "").slice(0, MAX_TEXT);
    const name = String(body.name || "").slice(0, 200);
    const images = (Array.isArray(body.images) ? body.images : []).slice(0, MAX_IMAGES)
      .filter(im => im && IMAGE_TYPES.includes(im.mime) && typeof im.data === "string");
    if (!text.trim() && !images.length) return reply(400, { error: "No syllabus text found." });

    // Optional per-visitor daily limit (needs the LIMITS KV binding).
    if (env.LIMITS) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const key = `n:${new Date().toISOString().slice(0, 10)}:${ip}`;
      const used = parseInt(await env.LIMITS.get(key)) || 0;
      const limit = parseInt(env.DAILY_LIMIT) || 25;
      if (used >= limit) return reply(429, { error: `Daily limit reached (${limit} syllabi). Try again tomorrow.` });
      await env.LIMITS.put(key, String(used + 1), { expirationTtl: 60 * 60 * 26 });
    }

    const parts = [{ text: `${INSTR}\n\nFile name: ${name}\nSyllabus${images.length ? " (page images attached)" : ""}:\n<<<\n${text}\n>>>` }];
    for (const im of images) parts.push({ inline_data: { mime_type: im.mime, data: im.data } });

    const model = env.GEMINI_MODEL || "gemini-flash-latest";
    let r, j;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_KEY },
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json" } }),
      });
      j = await r.json();
    } catch {
      return reply(502, { error: "Couldn't reach the AI service. Try again in a moment." });
    }
    if (r.status === 429) return reply(429, { error: "The site's free AI quota is used up for now. Try again later." });
    if (!r.ok) return reply(502, { error: "AI service error: " + (j && j.error && j.error.message || r.status) });

    const out = ((j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || []).map(p => p.text || "").join("");
    let parsed;
    try { parsed = JSON.parse(out); } catch {
      const m = out.match(/\{[\s\S]*\}/);
      try { parsed = m ? JSON.parse(m[0]) : null; } catch { parsed = null; }
    }
    if (!parsed) return reply(502, { error: "The AI reply couldn't be understood. Try again." });
    const courses = Array.isArray(parsed) ? parsed : Array.isArray(parsed.courses) ? parsed.courses : [parsed];
    return reply(200, { courses });
  },
};
