import { NextResponse } from "next/server";

import { isGmailConfigured } from "@/lib/workEmail/gmail";
import { listRecipients } from "@/lib/workEmail/recipients";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 收件人下拉数据 = 雇员库(emp_employee)里的人员;
 * 顺带回传 Gmail 是否已配置,供前端提前提示。
 */
export async function GET() {
  try {
    const recipients = await listRecipients();
    return NextResponse.json({
      success: true,
      recipients,
      gmailConfigured: isGmailConfigured(),
    });
  } catch (err) {
    console.error("[work-email/recipients] 失败", { name: (err as Error)?.name });
    return NextResponse.json(
      { success: false, error: "读取收件人列表失败。" },
      { status: 500 },
    );
  }
}
