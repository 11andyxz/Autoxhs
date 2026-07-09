import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { extractSkills } from "@/lib/job-hunter/interview/ai";
import { resumeToText } from "@/lib/job-hunter/interview/helpers";
import { bad, fail, rateLimited, tooMany } from "@/lib/job-hunter/interview/http";
import { createSession, getSkills, insertSkills } from "@/lib/job-hunter/interview/repo";
import { TailoredResumeSchema } from "@/lib/job-hunter/schema";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_JD = 30_000;

const BodySchema = z.object({
  resume: TailoredResumeSchema,
  jd: z.string(),
  weaknesses: z.array(z.string()).optional(),
});

export async function POST(req: NextRequest) {
  if (tooMany(req)) return rateLimited();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad("请求格式有误。");
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) return bad("缺少简历或 JD,请先生成简历。");

  const jd = parsed.data.jd.trim();
  if (!jd) return bad("请提供目标 JD。");
  if (jd.length > MAX_JD) return bad("JD 内容过长。");

  const resumeText = resumeToText(parsed.data.resume);
  if (!resumeText) return bad("简历内容为空。");

  try {
    const { language, skills } = await extractSkills(
      resumeText,
      jd,
      (parsed.data.weaknesses ?? []).slice(0, 50),
    );
    const sessionId = await createSession(language, jd, resumeText);
    await insertSkills(sessionId, skills);
    const rows = await getSkills(sessionId);
    return NextResponse.json({ success: true, sessionId, language, skills: rows });
  } catch (err) {
    return fail(err, "start");
  }
}
