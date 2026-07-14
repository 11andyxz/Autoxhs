"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* ========== 类型 ========== */

type SavedSig = {
  id: string;
  dataUrl: string; // PNG/JPEG dataURL
  aspect: number; // 高/宽
  label: string;
};

type OverlayItem = {
  id: string;
  page: number; // 0-based
  x: number; // 相对页面宽度的比例(左上角)
  y: number; // 相对页面高度的比例(左上角)
  kind: "image" | "text";
  // image
  dataUrl?: string;
  aspect?: number;
  w?: number; // 相对页面宽度的比例
  // text
  text?: string;
  fontPt?: number; // PDF 磅值
  color: "black" | "blue";
};

type PageInfo = {
  dataUrl: string; // 渲染好的页面位图
  wPt: number; // PDF 点单位宽
  hPt: number;
};

/** 待放置的内容:选中签名/文本后,点击页面任意位置放下。 */
type Pending =
  | { kind: "image"; dataUrl: string; aspect: number }
  | { kind: "text"; text: string; fontPt: number; color: "black" | "blue" };

const SIG_STORE_KEY = "pdfTools.signatures.v1";
const COLORS: Record<"black" | "blue", string> = { black: "#1a1a1a", blue: "#1d4ed8" };

/* ========== 小工具 ========== */

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** 裁掉画布四周的透明区域,返回 PNG dataURL;完全空白返回 null。 */
function cropCanvasToInk(canvas: HTMLCanvasElement, padding = 8): { dataUrl: string; aspect: number } | null {
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const { width, height } = canvas;
  const img = ctx.getImageData(0, 0, width, height);
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let yy = 0; yy < height; yy++) {
    for (let xx = 0; xx < width; xx++) {
      if (img.data[(yy * width + xx) * 4 + 3] > 10) {
        if (xx < minX) minX = xx;
        if (xx > maxX) maxX = xx;
        if (yy < minY) minY = yy;
        if (yy > maxY) maxY = yy;
      }
    }
  }
  if (maxX < 0) return null;
  minX = Math.max(0, minX - padding);
  minY = Math.max(0, minY - padding);
  maxX = Math.min(width - 1, maxX + padding);
  maxY = Math.min(height - 1, maxY + padding);
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.drawImage(canvas, minX, minY, w, h, 0, 0, w, h);
  return { dataUrl: out.toDataURL("image/png"), aspect: h / w };
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// PDF 内置 Helvetica 只支持 Latin-1,中文文本请用「打字签名」(以图片放入)。
const LATIN1_RE = /^[\x20-\x7E -ÿ]*$/;

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((m) => {
      // 静态资源由 scripts/copy-pdf-worker.mjs 复制到 public/pdfjs/(predev/prebuild 自动执行)
      m.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
      return m;
    });
  }
  return pdfjsPromise;
}

/* ========== 手写签名画板 ========== */

function DrawPad({ onSave }: { onSave: (sig: { dataUrl: string; aspect: number }) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [penWidth, setPenWidth] = useState(3);
  const [color, setColor] = useState<"black" | "blue">("black");
  const [dirty, setDirty] = useState(false);

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // 画布内部像素是 2x,坐标按比例换算
    return {
      x: ((e.clientX - rect.left) / rect.width) * e.currentTarget.width,
      y: ((e.clientY - rect.top) / rect.height) * e.currentTarget.height,
    };
  };

  const handleDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    last.current = pos(e);
  };

  const handleMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || !last.current) return;
    const ctx = e.currentTarget.getContext("2d");
    if (!ctx) return;
    const p = pos(e);
    ctx.strokeStyle = COLORS[color];
    ctx.lineWidth = penWidth * 2; // 2x 画布
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    // 中点二次曲线,笔迹更顺滑
    ctx.quadraticCurveTo(
      last.current.x,
      last.current.y,
      (last.current.x + p.x) / 2,
      (last.current.y + p.y) / 2,
    );
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    last.current = p;
    setDirty(true);
  };

  const handleUp = () => {
    drawing.current = false;
    last.current = null;
  };

  const clear = () => {
    const c = canvasRef.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    setDirty(false);
  };

  const save = () => {
    const c = canvasRef.current;
    if (!c) return;
    const sig = cropCanvasToInk(c);
    if (!sig) return;
    onSave(sig);
    clear();
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        width={1000}
        height={400}
        onPointerDown={handleDown}
        onPointerMove={handleMove}
        onPointerUp={handleUp}
        onPointerLeave={handleUp}
        className="h-[200px] w-full cursor-crosshair touch-none rounded-xl border border-slate-200 bg-[linear-gradient(to_bottom,transparent_74%,#e2e8f0_75%,transparent_76%)] bg-white"
      />
      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2 text-slate-600">
          笔粗
          <input
            type="range"
            min={1}
            max={6}
            value={penWidth}
            onChange={(e) => setPenWidth(Number(e.target.value))}
            className="accent-indigo-500"
          />
        </label>
        <div className="flex items-center gap-2">
          {(["black", "blue"] as const).map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={`h-6 w-6 rounded-full border-2 ${color === c ? "border-indigo-400" : "border-transparent"}`}
              style={{ backgroundColor: COLORS[c] }}
              aria-label={c === "black" ? "黑色" : "蓝色"}
            />
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          <button
            onClick={clear}
            className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 hover:border-slate-300"
          >
            清空
          </button>
          <button
            onClick={save}
            disabled={!dirty}
            className="rounded-lg bg-indigo-500 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            保存这个签名
          </button>
        </div>
      </div>
    </div>
  );
}

/* ========== 打字签名 ========== */

const SIG_FONTS = [
  { label: "圆润手写", css: '"Snell Roundhand", "Savoye LET", cursive' },
  { label: "书法体", css: '"Apple Chancery", cursive' },
  { label: "毛笔风", css: '"Brush Script MT", "Comic Sans MS", cursive' },
];

function TypePad({ onSave }: { onSave: (sig: { dataUrl: string; aspect: number }) => void }) {
  const [text, setText] = useState("");
  const [fontIdx, setFontIdx] = useState(0);
  const [color, setColor] = useState<"black" | "blue">("black");

  const save = () => {
    const t = text.trim();
    if (!t) return;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d")!;
    const font = `96px ${SIG_FONTS[fontIdx].css}`;
    ctx.font = font;
    const m = ctx.measureText(t);
    canvas.width = Math.ceil(m.width + 60);
    canvas.height = 200;
    const ctx2 = canvas.getContext("2d")!;
    ctx2.font = font;
    ctx2.fillStyle = COLORS[color];
    ctx2.textBaseline = "middle";
    ctx2.fillText(t, 30, 100);
    const sig = cropCanvasToInk(canvas);
    if (sig) onSave(sig);
  };

  return (
    <div>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="输入你的名字,如 Andy Zheng / 郑安迪"
        className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
      />
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {SIG_FONTS.map((f, i) => (
          <button
            key={f.label}
            onClick={() => setFontIdx(i)}
            className={`rounded-xl border px-3 py-3 transition ${
              fontIdx === i ? "border-indigo-400 bg-indigo-50" : "border-slate-200 bg-white hover:border-slate-300"
            }`}
          >
            <span className="block truncate text-2xl" style={{ fontFamily: f.css, color: COLORS[color] }}>
              {text.trim() || "Signature"}
            </span>
            <span className="mt-1 block text-[10px] text-slate-400">{f.label}</span>
          </button>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-4">
        <div className="flex items-center gap-2">
          {(["black", "blue"] as const).map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={`h-6 w-6 rounded-full border-2 ${color === c ? "border-indigo-400" : "border-transparent"}`}
              style={{ backgroundColor: COLORS[c] }}
              aria-label={c === "black" ? "黑色" : "蓝色"}
            />
          ))}
        </div>
        <button
          onClick={save}
          disabled={!text.trim()}
          className="ml-auto rounded-lg bg-indigo-500 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
        >
          保存这个签名
        </button>
      </div>
    </div>
  );
}

/* ========== 主编辑器 ========== */

export default function SignEditor() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sigUploadRef = useRef<HTMLInputElement>(null);
  const pagesBoxRef = useRef<HTMLDivElement>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const origBytesRef = useRef<ArrayBuffer | null>(null);
  const [pages, setPages] = useState<PageInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasRotatedPage, setHasRotatedPage] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sigs, setSigs] = useState<SavedSig[]>([]);
  const [sigTab, setSigTab] = useState<"draw" | "type" | "upload">("draw");
  const [showSigPanel, setShowSigPanel] = useState(false);

  const [items, setItems] = useState<OverlayItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const [textDraft, setTextDraft] = useState("");
  const [textPt, setTextPt] = useState(11);
  const [textColor, setTextColor] = useState<"black" | "blue">("black");
  const [textError, setTextError] = useState<string | null>(null);

  const [exporting, setExporting] = useState(false);
  // 页面在屏幕上的实际显示宽度,用于把 pt 字号换算成 px(与导出结果一致)
  const [boxW, setBoxW] = useState(860);

  // 拖拽状态(不进 React state,避免每帧重渲染引用失效)
  const dragRef = useRef<{
    id: string;
    mode: "move" | "resize";
    startX: number;
    startY: number;
    orig: OverlayItem;
    rect: DOMRect;
  } | null>(null);
  // 刚拖拽完毕时,浏览器还会派发一次 click 到页面容器,用它挡掉误触发
  const didDragRef = useRef(false);
  // 加载令牌:加载中若换了文件,旧循环立刻作废,避免两个文件的页面交错
  const loadTokenRef = useRef(0);

  /* --- 实测页面显示宽度 --- */
  useEffect(() => {
    const el = pagesBoxRef.current;
    if (!el || pages.length === 0) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    setBoxW(el.clientWidth);
    return () => ro.disconnect();
  }, [pages.length]);

  /* --- 签名库持久化 --- */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(SIG_STORE_KEY);
      if (raw) setSigs(JSON.parse(raw) as SavedSig[]);
    } catch {
      /* 损坏则忽略 */
    }
  }, []);

  const persistSigs = useCallback((next: SavedSig[]) => {
    setSigs(next);
    try {
      localStorage.setItem(SIG_STORE_KEY, JSON.stringify(next));
    } catch {
      /* 配额满等,忽略,签名仍可本次使用 */
    }
  }, []);

  const addSig = useCallback(
    (sig: { dataUrl: string; aspect: number }, label: string) => {
      persistSigs([...sigs, { id: uid(), dataUrl: sig.dataUrl, aspect: sig.aspect, label }]);
      setShowSigPanel(false);
    },
    [sigs, persistSigs],
  );

  /* --- 打开 PDF 并渲染 --- */
  const openPdf = async (file: File) => {
    const token = ++loadTokenRef.current;
    setLoading(true);
    setError(null);
    setPages([]);
    setItems([]);
    setSelectedId(null);
    setPending(null);
    try {
      const bytes = await file.arrayBuffer();
      console.log("[dbg] got bytes", bytes.byteLength);
      // pdfjs 会把传入的 buffer 转交给 worker(detach),必须给它一份拷贝
      origBytesRef.current = bytes;
      const pdfjs = await loadPdfjs();
      const task = pdfjs.getDocument({
        data: new Uint8Array(bytes.slice(0)),
        // v6 渲染 ICC 彩图 / 内嵌缺失字体时按这些 URL 取资源,不给则 render 会挂起
        wasmUrl: "/pdfjs/wasm/",
        iccUrl: "/pdfjs/iccs/",
        standardFontDataUrl: "/pdfjs/standard_fonts/",
        cMapUrl: "/pdfjs/cmaps/",
        cMapPacked: true,
      });
      const doc = await task.promise;
      setFileName(file.name);
      let rotated = false;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      // 渲染一页就先展示一页,大文件不用干等。
      // 注意:标签页被切到后台时,Chrome 会节流 canvas 渲染,进度会停在
      // 「正在渲染」;切回前台即自动继续,这是浏览器行为,非卡死。
      for (let i = 1; i <= doc.numPages; i++) {
        if (loadTokenRef.current !== token) {
          await task.destroy();
          return;
        }
        const page = await doc.getPage(i);
        if (page.rotate % 360 !== 0) rotated = true;
        const vp1 = page.getViewport({ scale: 1 });
        const scale = (860 / vp1.width) * dpr;
        const vp = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        const ctx = canvas.getContext("2d")!;
        await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
        const info: PageInfo = {
          dataUrl: canvas.toDataURL("image/jpeg", 0.9),
          wPt: vp1.width,
          hPt: vp1.height,
        };
        if (loadTokenRef.current === token) setPages((prev) => [...prev, info]);
        page.cleanup();
      }
      await task.destroy();
      setHasRotatedPage(rotated);
    } catch (e) {
      console.error("[pdf-tools] 打开 PDF 失败", e);
      if (loadTokenRef.current === token) {
        setError(
          /password/i.test(String(e)) ? "PDF 已加密,请先解除密码保护。" : "无法打开这个 PDF,请确认文件未损坏。",
        );
      }
    } finally {
      if (loadTokenRef.current === token) setLoading(false);
    }
  };

  /* --- 放置:选中签名/文本后点击页面 --- */
  const handlePageClick = (pageIdx: number, e: React.MouseEvent<HTMLDivElement>) => {
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }
    if (!pending) {
      setSelectedId(null);
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    const page = pages[pageIdx];
    let item: OverlayItem;
    if (pending.kind === "image") {
      const w = 0.22;
      const h = (w * pending.aspect * page.wPt) / page.hPt;
      item = {
        id: uid(),
        page: pageIdx,
        kind: "image",
        dataUrl: pending.dataUrl,
        aspect: pending.aspect,
        w,
        x: Math.min(Math.max(fx - w / 2, 0), 1 - w),
        y: Math.min(Math.max(fy - h / 2, 0), 1 - h),
        color: "black",
      };
    } else {
      item = {
        id: uid(),
        page: pageIdx,
        kind: "text",
        text: pending.text,
        fontPt: pending.fontPt,
        color: pending.color,
        x: Math.min(Math.max(fx, 0), 0.95),
        y: Math.min(Math.max(fy - (pending.fontPt / page.hPt) / 2, 0), 0.97),
      };
    }
    setItems((prev) => [...prev, item]);
    setSelectedId(item.id);
    setPending(null);
  };

  /* --- 拖动 / 缩放 --- */
  const startDrag = (
    e: React.PointerEvent,
    item: OverlayItem,
    mode: "move" | "resize",
  ) => {
    e.stopPropagation();
    e.preventDefault();
    const pageEl = (e.currentTarget as HTMLElement).closest("[data-page]");
    if (!pageEl) return;
    dragRef.current = {
      id: item.id,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      orig: { ...item },
      rect: pageEl.getBoundingClientRect(),
    };
    setSelectedId(item.id);
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
  };

  const onDragMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    didDragRef.current = true;
    const dx = (e.clientX - d.startX) / d.rect.width;
    const dy = (e.clientY - d.startY) / d.rect.height;
    setItems((prev) =>
      prev.map((it) => {
        if (it.id !== d.id) return it;
        if (d.mode === "move") {
          const maxX = it.kind === "image" ? 1 - (it.w || 0.2) : 0.98;
          return {
            ...it,
            x: Math.min(Math.max(d.orig.x + dx, 0), Math.max(maxX, 0)),
            y: Math.min(Math.max(d.orig.y + dy, 0), 0.98),
          };
        }
        // resize:横向拖改宽度(等比)
        if (it.kind === "image") {
          const w = Math.min(Math.max((d.orig.w || 0.2) + dx, 0.04), 0.9);
          return { ...it, w };
        }
        const fontPt = Math.min(Math.max((d.orig.fontPt || 11) * (1 + dx * 4), 6), 72);
        return { ...it, fontPt: Math.round(fontPt * 10) / 10 };
      }),
    );
  }, []);

  const onDragEnd = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    // click 事件在 pointerup 后同步派发;若拖到了页面外没有 click,下一轮宏任务里复位
    setTimeout(() => {
      didDragRef.current = false;
    }, 0);
  }, [onDragMove]);

  /* --- 文本项 --- */
  const armText = () => {
    const t = textDraft.trim();
    if (!t) return;
    if (!LATIN1_RE.test(t)) {
      setTextError("文本项只支持英文/数字(PDF 内置字体不含中文)。中文请用「打字签名」以图片方式放入。");
      return;
    }
    setTextError(null);
    setPending({ kind: "text", text: t, fontPt: textPt, color: textColor });
  };

  const todayStr = () => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mm}/${dd}/${d.getFullYear()}`;
  };

  /* --- 导出 --- */
  const exportPdf = async () => {
    if (!origBytesRef.current || exporting) return;
    setExporting(true);
    setError(null);
    try {
      const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
      const doc = await PDFDocument.load(origBytesRef.current);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const pdfPages = doc.getPages();
      for (const item of items) {
        const page = pdfPages[item.page];
        if (!page) continue;
        const pw = page.getWidth();
        const ph = page.getHeight();
        if (item.kind === "image" && item.dataUrl) {
          const bytes = dataUrlToBytes(item.dataUrl);
          const img = item.dataUrl.startsWith("data:image/png")
            ? await doc.embedPng(bytes)
            : await doc.embedJpg(bytes);
          const w = (item.w || 0.2) * pw;
          const h = w * (item.aspect || 0.4);
          page.drawImage(img, {
            x: item.x * pw,
            y: ph - item.y * ph - h,
            width: w,
            height: h,
          });
        } else if (item.kind === "text" && item.text) {
          const size = item.fontPt || 11;
          const c = item.color === "blue" ? rgb(0.11, 0.31, 0.85) : rgb(0.1, 0.1, 0.1);
          page.drawText(item.text, {
            x: item.x * pw,
            // 显示时 y 是文本顶端;drawText 的 y 是基线,按 0.75em 折算
            y: ph - item.y * ph - size * 0.75,
            size,
            font,
            color: c,
          });
        }
      }
      const outBytes = await doc.save();
      const blob = new Blob([outBytes as unknown as BlobPart], { type: "application/pdf" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (fileName || "document.pdf").replace(/\.pdf$/i, "") + "-signed.pdf";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      console.error("[pdf-tools] 导出失败", e);
      setError("导出失败,请重试。若 PDF 有特殊加密,请先解除。");
    } finally {
      setExporting(false);
    }
  };

  /* ========== 渲染 ========== */

  return (
    <div>
      {/* ① 选择 PDF */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-800">① 选择 PDF 文件</h2>
        <p className="mt-1 text-xs text-slate-400">文件全程在浏览器本地处理,不会上传到任何服务器。</p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void openPdf(f);
          }}
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          className="mt-3 w-full rounded-xl border-2 border-dashed border-slate-200 px-4 py-6 text-sm text-slate-500 transition hover:border-indigo-300 hover:text-indigo-600"
        >
          {loading ? "正在渲染页面…" : fileName ? `已打开:${fileName}(点击可更换)` : "点击选择 PDF 文件"}
        </button>
        {hasRotatedPage && (
          <p className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-700">
            这个 PDF 有旋转过的页面,签名位置可能出现偏差,导出后请打开检查。
          </p>
        )}
        {error && <p className="mt-3 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</p>}
      </div>

      {pages.length > 0 && (
        <>
          {/* ② 签名与文本工具 */}
          <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-800">② 我的签名</h2>
              <button
                onClick={() => setShowSigPanel((v) => !v)}
                className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-600 hover:bg-indigo-100"
              >
                {showSigPanel ? "收起" : "+ 新建签名"}
              </button>
            </div>

            {sigs.length === 0 && !showSigPanel && (
              <p className="mt-3 text-sm text-slate-400">还没有签名,点右上角「新建签名」创建一个(会保存在本机,下次直接用)。</p>
            )}

            {/* 签名库 */}
            {sigs.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-3">
                {sigs.map((s) => {
                  const armed =
                    pending?.kind === "image" && pending.dataUrl === s.dataUrl;
                  return (
                    <div
                      key={s.id}
                      className={`group relative rounded-xl border p-2 transition ${
                        armed ? "border-indigo-400 bg-indigo-50 ring-1 ring-indigo-300" : "border-slate-200 bg-white hover:border-indigo-300"
                      }`}
                    >
                      <button
                        onClick={() =>
                          setPending(
                            armed ? null : { kind: "image", dataUrl: s.dataUrl, aspect: s.aspect },
                          )
                        }
                        title="点击选中,再点到页面上想放的位置"
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={s.dataUrl} alt={s.label} className="h-12 max-w-[160px] object-contain" />
                      </button>
                      <span className="mt-1 block text-center text-[10px] text-slate-400">{s.label}</span>
                      <button
                        onClick={() => persistSigs(sigs.filter((x) => x.id !== s.id))}
                        className="absolute -right-2 -top-2 hidden h-5 w-5 items-center justify-center rounded-full bg-slate-700 text-[10px] text-white group-hover:flex"
                        aria-label="删除签名"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* 新建签名面板 */}
            {showSigPanel && (
              <div className="mt-4 rounded-xl border border-slate-100 bg-slate-50/60 p-4">
                <div className="mb-3 flex gap-2">
                  {(
                    [
                      ["draw", "✍️ 手绘"],
                      ["type", "⌨️ 打字"],
                      ["upload", "🖼 上传图片"],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      onClick={() => setSigTab(k)}
                      className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                        sigTab === k ? "bg-indigo-500 text-white" : "bg-white text-slate-500 hover:text-slate-700"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {sigTab === "draw" && <DrawPad onSave={(s) => addSig(s, "手绘签名")} />}
                {sigTab === "type" && <TypePad onSave={(s) => addSig(s, "打字签名")} />}
                {sigTab === "upload" && (
                  <div>
                    <input
                      ref={sigUploadRef}
                      type="file"
                      accept="image/png,image/jpeg"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        const reader = new FileReader();
                        reader.onload = () => {
                          const dataUrl = String(reader.result);
                          const img = new Image();
                          img.onload = () =>
                            addSig({ dataUrl, aspect: img.height / img.width }, "上传签名");
                          img.src = dataUrl;
                        };
                        reader.readAsDataURL(f);
                        e.target.value = "";
                      }}
                    />
                    <button
                      onClick={() => sigUploadRef.current?.click()}
                      className="w-full rounded-xl border-2 border-dashed border-slate-200 bg-white px-4 py-6 text-sm text-slate-500 transition hover:border-indigo-300 hover:text-indigo-600"
                    >
                      选择签名图片(PNG 透明底效果最佳,JPG 也可以)
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* 文本工具 */}
            <div className="mt-4 border-t border-slate-100 pt-4">
              <h3 className="text-xs font-semibold text-slate-600">补充文本(姓名 / 日期 / 证件号等)</h3>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  value={textDraft}
                  onChange={(e) => setTextDraft(e.target.value)}
                  placeholder="如 Andy Zheng 或 07/13/2026"
                  className="w-56 rounded-xl border border-slate-200 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
                />
                <button
                  onClick={() => setTextDraft(todayStr())}
                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-500 hover:border-slate-300"
                >
                  今天日期
                </button>
                <select
                  value={textPt}
                  onChange={(e) => setTextPt(Number(e.target.value))}
                  className="rounded-lg border border-slate-200 px-2 py-1.5 text-xs text-slate-600"
                >
                  {[9, 10, 11, 12, 14, 18, 24].map((n) => (
                    <option key={n} value={n}>
                      {n}pt
                    </option>
                  ))}
                </select>
                <div className="flex items-center gap-1.5">
                  {(["black", "blue"] as const).map((c) => (
                    <button
                      key={c}
                      onClick={() => setTextColor(c)}
                      className={`h-5 w-5 rounded-full border-2 ${textColor === c ? "border-indigo-400" : "border-transparent"}`}
                      style={{ backgroundColor: COLORS[c] }}
                      aria-label={c === "black" ? "黑色" : "蓝色"}
                    />
                  ))}
                </div>
                <button
                  onClick={armText}
                  disabled={!textDraft.trim()}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    pending?.kind === "text"
                      ? "bg-indigo-500 text-white"
                      : "border border-indigo-200 bg-indigo-50 text-indigo-600 hover:bg-indigo-100 disabled:cursor-not-allowed disabled:opacity-50"
                  }`}
                >
                  {pending?.kind === "text" ? "点击页面放置…" : "放置文本"}
                </button>
              </div>
              {textError && <p className="mt-2 text-xs text-rose-500">{textError}</p>}
            </div>

            {pending && (
              <p className="mt-3 rounded-xl bg-indigo-50 px-4 py-2.5 text-xs text-indigo-700">
                👆 已选中{pending.kind === "image" ? "签名" : "文本"},现在点击下方页面上想放的位置(再点一次选中项可取消)。
              </p>
            )}
          </div>

          {/* ③ 页面 + 覆盖层 */}
          <div className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-slate-800">
                ③ 放置与调整 <span className="ml-1 text-xs font-normal text-slate-400">拖动移动 · 拖右下角手柄缩放 · 选中后点 ✕ 删除</span>
              </h2>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-400">已放置 {items.length} 项</span>
                <button
                  onClick={exportPdf}
                  disabled={items.length === 0 || exporting}
                  className="rounded-xl bg-indigo-500 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {exporting ? "正在合成…" : "导出签名版 PDF"}
                </button>
              </div>
            </div>

            <div ref={pagesBoxRef} className="mt-4 space-y-6">
              {pages.map((p, idx) => (
                <div key={idx}>
                  <p className="mb-1 text-xs text-slate-400">第 {idx + 1} / {pages.length} 页</p>
                  <div
                    data-page={idx}
                    onClick={(e) => handlePageClick(idx, e)}
                    className={`relative w-full overflow-hidden rounded-lg border border-slate-200 shadow-sm ${
                      pending ? "cursor-crosshair ring-2 ring-indigo-300" : ""
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.dataUrl} alt={`第 ${idx + 1} 页`} className="block w-full select-none" draggable={false} />
                    {items
                      .filter((it) => it.page === idx)
                      .map((it) => {
                        const selected = it.id === selectedId;
                        const common =
                          "absolute touch-none " +
                          (selected
                            ? "outline outline-2 outline-indigo-400 "
                            : "outline outline-1 outline-transparent hover:outline-indigo-200 ");
                        if (it.kind === "image") {
                          const wPct = (it.w || 0.2) * 100;
                          return (
                            <div
                              key={it.id}
                              className={common + "cursor-move"}
                              style={{ left: `${it.x * 100}%`, top: `${it.y * 100}%`, width: `${wPct}%` }}
                              onPointerDown={(e) => startDrag(e, it, "move")}
                              onClick={(e) => e.stopPropagation()}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={it.dataUrl} alt="签名" className="block w-full select-none" draggable={false} />
                              {selected && (
                                <>
                                  <button
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setItems((prev) => prev.filter((x) => x.id !== it.id));
                                      setSelectedId(null);
                                    }}
                                    className="absolute -right-2.5 -top-2.5 flex h-5 w-5 items-center justify-center rounded-full bg-slate-700 text-[10px] text-white"
                                    aria-label="删除"
                                  >
                                    ✕
                                  </button>
                                  <div
                                    onPointerDown={(e) => startDrag(e, it, "resize")}
                                    className="absolute -bottom-1.5 -right-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-sm border border-white bg-indigo-500"
                                  />
                                </>
                              )}
                            </div>
                          );
                        }
                        // 文本项:pt 字号按「显示宽 / 页面 pt 宽」换算成 px,与导出一致
                        const fontPx = ((it.fontPt || 11) / p.wPt) * boxW;
                        return (
                          <div
                            key={it.id}
                            className={common + "cursor-move whitespace-pre px-0.5"}
                            style={{
                              left: `${it.x * 100}%`,
                              top: `${it.y * 100}%`,
                              fontSize: `${fontPx}px`,
                              lineHeight: 1,
                              color: COLORS[it.color],
                              fontFamily: "Helvetica, Arial, sans-serif",
                            }}
                            onPointerDown={(e) => startDrag(e, it, "move")}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {it.text}
                            {selected && (
                              <>
                                <button
                                  onPointerDown={(e) => e.stopPropagation()}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setItems((prev) => prev.filter((x) => x.id !== it.id));
                                    setSelectedId(null);
                                  }}
                                  className="absolute -right-2.5 -top-2.5 flex h-5 w-5 items-center justify-center rounded-full bg-slate-700 text-[10px] text-white"
                                  aria-label="删除"
                                >
                                  ✕
                                </button>
                                <div
                                  onPointerDown={(e) => startDrag(e, it, "resize")}
                                  className="absolute -bottom-1.5 -right-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-sm border border-white bg-indigo-500"
                                />
                              </>
                            )}
                          </div>
                        );
                      })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
