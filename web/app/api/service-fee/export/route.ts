import { NextResponse, type NextRequest } from "next/server";

import { calculateServiceFee } from "@/lib/serviceFee/calc";
import { buildServiceFeeWorkbook } from "@/lib/serviceFee/excel";
import { exportFileName } from "@/lib/serviceFee/filename";
import type { CalculationResult, PriorCharges, ServiceFeeInputs } from "@/lib/serviceFee/types";
import { validateInputs } from "@/lib/serviceFee/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMPTY: PriorCharges = { payrollMonths: [], serviceMonths: [], taxWeeks: [] };

export async function POST(req: NextRequest) {
  let body: {
    inputs?: ServiceFeeInputs;
    priorCharges?: PriorCharges;
    result?: CalculationResult;
    clientName?: string;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  const clientName = (body.clientName ?? "").trim();
  if (!clientName) {
    return NextResponse.json({ success: false, error: "请先填写客户姓名。" }, { status: 400 });
  }

  let result: CalculationResult;
  if (body.result) {
    result = body.result; // 导出已保存的历史记录
  } else {
    if (!body.inputs) {
      return NextResponse.json({ success: false, error: "缺少计算输入。" }, { status: 400 });
    }
    const errors = validateInputs(body.inputs);
    if (errors.length) {
      return NextResponse.json({ success: false, error: errors[0] }, { status: 400 });
    }
    result = calculateServiceFee(body.inputs, body.priorCharges ?? EMPTY);
  }

  try {
    const generatedAt = new Date().toLocaleString("en-US");
    const buffer = await buildServiceFeeWorkbook(result, clientName, generatedAt);
    const filename = exportFileName(clientName, result.inputStartDateISO, result.inputEndDateISO);
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[service-fee/export] 失败", { name: (err as Error)?.name });
    return NextResponse.json({ success: false, error: "导出失败,请稍后重试。" }, { status: 500 });
  }
}
