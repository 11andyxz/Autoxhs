import { NextResponse, type NextRequest } from "next/server";

import { buildServiceFeeWorkbook } from "@/lib/serviceFee/excel";
import type { ServiceFeeInputs } from "@/lib/serviceFee/types";
import { validateInputs } from "@/lib/serviceFee/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let inputs: ServiceFeeInputs;
  try {
    inputs = (await req.json()) as ServiceFeeInputs;
  } catch {
    return NextResponse.json({ success: false, error: "请求格式有误。" }, { status: 400 });
  }

  const errors = validateInputs(inputs);
  if (errors.length) {
    return NextResponse.json({ success: false, error: errors[0] }, { status: 400 });
  }

  try {
    const generatedAt = new Date().toLocaleString("en-US");
    const buffer = await buildServiceFeeWorkbook(inputs, generatedAt);
    const filename = `Service_Fee_Calculation_${inputs.startDate}_to_${inputs.endDate}.xlsx`;
    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[service-fee/export] 生成失败", {
      name: (err as { name?: string } | null)?.name ?? "Unknown",
    });
    return NextResponse.json(
      { success: false, error: "导出失败,请稍后重试。" },
      { status: 500 },
    );
  }
}
