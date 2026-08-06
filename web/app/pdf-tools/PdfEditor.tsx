"use client";

/**
 * 「编辑 PDF 内容」:改原文里的字、加文字、涂白遮盖、高亮、插图片、页面增删转序,
 * 全程在浏览器本地完成(文件不上传),导出用 lib/pdfTools/pdfEditApply.ts 合成。
 *
 * 坐标约定见 lib/pdfTools/pdfEdit.ts:一律用 PDF 用户空间的点(pt,原点左下角)。
 * 页面位图一律按 rotation: 0 渲染(忽略 /Rotate),这样位图坐标系 = 用户空间,
 * 覆盖层不用做旋转换算;视觉朝向由外层 CSS 旋转(源页 /Rotate + 用户旋转增量)负责。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  applyInvMat,
  applyMat,
  blockBox,
  cssFontFamily,
  cssToRgb,
  deletePageSlot,
  estimateWidthPt,
  fontKeyFor,
  groupIntoBlocks,
  movePageSlot,
  needsUnicodeFont,
  rgbToCss,
  rotatePageSlot,
  sampleColors,
  screenToLocalFraction,
  type Family,
  type FontMeta,
  type Mat,
  type PageSlot,
  type RawTextItem,
  type RGB,
  type TextBlock,
} from "@/lib/pdfTools/pdfEdit";
import { applyPdfEdits, type EditItem, type EditPlan } from "@/lib/pdfTools/pdfEditApply";

/* ========== 类型 ========== */

type Tool = "select" | "text" | "whiteout" | "highlight" | "image";

interface UiBlock extends TextBlock {
  /** 从页面位图里取到的文字色 / 底色 */
  ink: RGB;
  bg: RGB;
}

interface PageRender {
  src: number;
  dataUrl: string;
  /** 视口尺寸(scale=1,rotation=0)= 未旋转的页面 pt 尺寸 */
  vpW: number;
  vpH: number;
  /** pdf 点 → 视口(scale=1)矩阵 */
  transform: Mat;
  /** 源页自带的 /Rotate */
  srcRotate: number;
  blocks: UiBlock[];
}

/** 对原文某一段的改写。text 为空 = 只遮盖(删掉这段字)。 */
interface BlockEdit {
  text: string;
  size: number;
  bold: boolean;
  italic: boolean;
  family: Family;
  color: string;
  /** 遮盖底色 */
  bg: string;
  /** 缩字号以塞进原来的宽度 */
  fit: boolean;
}

type Anno =
  | {
      id: string;
      kind: "text";
      page: number;
      x: number;
      baseline: number;
      text: string;
      size: number;
      family: Family;
      bold: boolean;
      italic: boolean;
      color: string;
    }
  | { id: string; kind: "whiteout"; page: number; x: number; y: number; w: number; h: number; color: string }
  | { id: string; kind: "highlight"; page: number; x: number; y: number; w: number; h: number; color: string }
  | {
      id: string;
      kind: "image";
      page: number;
      x: number;
      y: number;
      w: number;
      h: number;
      dataUrl: string;
      aspect: number;
    };

interface DocState {
  pages: PageSlot[];
  edits: Record<string, BlockEdit>;
  annos: Anno[];
}

type Selection = { kind: "block"; id: string } | { kind: "anno"; id: string } | null;

const EMPTY_DOC: DocState = { pages: [], edits: {}, annos: [] };

const TEXT_COLORS = ["#1a1a1a", "#1d4ed8", "#dc2626", "#15803d", "#ffffff"];
const HIGHLIGHT_COLOR = "#fde047";
const RENDER_CSS_WIDTH = 860;
/** 扁平化导出时的重渲染倍率(≈180dpi,肉眼看不出降质) */
const FLATTEN_SCALE = 2.5;

/* ========== 小工具 ========== */

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

let pdfjsPromise: Promise<typeof import("pdfjs-dist")> | null = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist").then((m) => {
      m.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
      return m;
    });
  }
  return pdfjsPromise;
}

const PDFJS_ASSETS = {
  wasmUrl: "/pdfjs/wasm/",
  iccUrl: "/pdfjs/iccs/",
  standardFontDataUrl: "/pdfjs/standard_fonts/",
  cMapUrl: "/pdfjs/cmaps/",
  cMapPacked: true,
} as const;

/** 中文等字符要嵌入的字体(由 scripts/copy-pdf-worker.mjs 复制到 public/pdfjs/fonts/)。 */
async function loadUnicodeFont(bold: boolean): Promise<Uint8Array> {
  const url = `/pdfjs/fonts/NotoSansSC-${bold ? "Bold" : "Regular"}.otf`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`取中文字体失败(${url}):${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** pdfjs 渲染完这一页后,才能从 commonObjs 里读到真实字体名与粗斜体标记。 */
function readFontMetas(
  page: { objs: { has(k: string): boolean; get(k: string): unknown }; commonObjs: { has(k: string): boolean; get(k: string): unknown } },
  styles: Record<string, { fontFamily?: string; ascent?: number; descent?: number } | undefined>,
  names: Set<string>,
): Map<string, FontMeta> {
  const out = new Map<string, FontMeta>();
  for (const name of names) {
    const style = styles[name];
    const meta: FontMeta = {
      fallback: style?.fontFamily,
      ascent: typeof style?.ascent === "number" && style.ascent > 0 ? style.ascent : undefined,
      descent: typeof style?.descent === "number" && style.descent < 0 ? style.descent : undefined,
    };
    for (const pool of [page.objs, page.commonObjs]) {
      try {
        if (pool.has(name)) {
          const obj = pool.get(name) as { name?: string; bold?: boolean; italic?: boolean } | null;
          if (obj && typeof obj === "object") {
            meta.name = typeof obj.name === "string" ? obj.name : meta.name;
            if (typeof obj.bold === "boolean") meta.bold = obj.bold;
            if (typeof obj.italic === "boolean") meta.italic = obj.italic;
          }
        }
      } catch {
        /* 对象没就绪,退回名字猜测 */
      }
    }
    out.set(name, meta);
  }
  return out;
}

/** pt 矩形(左下角原点)→ 覆盖层百分比。 */
function rectToPct(render: PageRender, r: { x: number; y: number; w: number; h: number }) {
  const [x1, y1] = applyMat(render.transform, r.x, r.y);
  const [x2, y2] = applyMat(render.transform, r.x + r.w, r.y + r.h);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  return {
    left: (left / render.vpW) * 100,
    top: (top / render.vpH) * 100,
    width: (Math.abs(x2 - x1) / render.vpW) * 100,
    height: (Math.abs(y2 - y1) / render.vpH) * 100,
  };
}

/** 屏幕坐标 → 该页的 pt 坐标。 */
function screenToPt(
  render: PageRender,
  totalRotate: number,
  box: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const { fx, fy } = screenToLocalFraction(box, totalRotate, clientX, clientY);
  const [x, y] = applyInvMat(render.transform, fx * render.vpW, fy * render.vpH);
  return { x, y };
}

function download(bytes: Uint8Array, name: string) {
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ========== 主组件 ========== */

export default function PdfEditor() {
  const fileRef = useRef<HTMLInputElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const bytesRef = useRef<ArrayBuffer | null>(null);
  const pdfDocRef = useRef<{
    getPage(n: number): Promise<unknown>;
    destroy?(): Promise<void>;
  } | null>(null);
  const taskRef = useRef<{ destroy(): Promise<void> } | null>(null);
  const loadTokenRef = useRef(0);

  const [renders, setRenders] = useState<Map<number, PageRender>>(new Map());
  const [doc, setDoc] = useState<DocState>(EMPTY_DOC);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [tool, setTool] = useState<Tool>("select");
  const [selected, setSelected] = useState<Selection>(null);
  const [pendingImage, setPendingImage] = useState<{ dataUrl: string; aspect: number } | null>(null);
  const [flatten, setFlatten] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [boxW, setBoxW] = useState(RENDER_CSS_WIDTH);

  // 撤销 / 重做
  const pastRef = useRef<DocState[]>([]);
  const futureRef = useRef<DocState[]>([]);
  const [histLen, setHistLen] = useState({ past: 0, future: 0 });

  const syncHist = () => setHistLen({ past: pastRef.current.length, future: futureRef.current.length });

  /** 所有会改文档的操作都走这里,自动记一步历史。 */
  const mutate = useCallback((fn: (prev: DocState) => DocState) => {
    setDoc((prev) => {
      const next = fn(prev);
      if (next === prev) return prev;
      pastRef.current = [...pastRef.current.slice(-49), prev];
      futureRef.current = [];
      queueMicrotask(syncHist);
      return next;
    });
  }, []);

  const undo = useCallback(() => {
    setDoc((cur) => {
      const prev = pastRef.current.pop();
      if (!prev) return cur;
      futureRef.current = [...futureRef.current, cur];
      queueMicrotask(syncHist);
      return prev;
    });
    setSelected(null);
  }, []);

  const redo = useCallback(() => {
    setDoc((cur) => {
      const next = futureRef.current.pop();
      if (!next) return cur;
      pastRef.current = [...pastRef.current, cur];
      queueMicrotask(syncHist);
      return next;
    });
    setSelected(null);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && /^(input|textarea|select)$/i.test(target.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        if (typing) return;
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key === "Escape") {
        setSelected(null);
        setPendingImage(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || doc.pages.length === 0) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    setBoxW(el.clientWidth);
    return () => ro.disconnect();
  }, [doc.pages.length]);

  useEffect(
    () => () => {
      void taskRef.current?.destroy().catch(() => {});
    },
    [],
  );

  /* --- 打开 PDF:渲染 + 抽文字块 + 取色 --- */
  const openPdf = async (file: File) => {
    const token = ++loadTokenRef.current;
    setLoading(true);
    setError(null);
    setNotice(null);
    setRenders(new Map());
    setDoc(EMPTY_DOC);
    setSelected(null);
    pastRef.current = [];
    futureRef.current = [];
    syncHist();
    void taskRef.current?.destroy().catch(() => {});
    taskRef.current = null;
    pdfDocRef.current = null;

    try {
      const buf = await file.arrayBuffer();
      bytesRef.current = buf;
      const pdfjs = await loadPdfjs();
      // pdfjs 会接管(detach)传进去的 buffer,给它一份拷贝
      const task = pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)), ...PDFJS_ASSETS });
      taskRef.current = task as unknown as { destroy(): Promise<void> };
      const pdf = await task.promise;
      if (loadTokenRef.current !== token) return;
      pdfDocRef.current = pdf as unknown as typeof pdfDocRef.current;
      setFileName(file.name);
      setProgress({ done: 0, total: pdf.numPages });

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      for (let i = 1; i <= pdf.numPages; i++) {
        if (loadTokenRef.current !== token) return;
        const page = await pdf.getPage(i);
        // rotation: 0 —— 位图坐标系与 PDF 用户空间一致,朝向交给 CSS
        const vp1 = page.getViewport({ scale: 1, rotation: 0 });
        const scale = (RENDER_CSS_WIDTH / vp1.width) * dpr;
        const vp = page.getViewport({ scale, rotation: 0 });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
        // 注意:标签页在后台时 Chrome 会节流 canvas 渲染,进度会停住,切回前台自动继续
        await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;

        const tc = await page.getTextContent();
        const items: RawTextItem[] = [];
        const names = new Set<string>();
        for (const raw of tc.items) {
          const it = raw as {
            str?: unknown;
            transform?: unknown;
            width?: unknown;
            height?: unknown;
            fontName?: unknown;
          };
          if (typeof it.str !== "string" || !Array.isArray(it.transform)) continue;
          const t = it.transform as number[];
          const fontName = typeof it.fontName === "string" ? it.fontName : undefined;
          if (fontName) names.add(fontName);
          items.push({
            str: it.str,
            x: t[4] ?? 0,
            y: t[5] ?? 0,
            width: typeof it.width === "number" ? it.width : 0,
            height:
              (typeof it.height === "number" && it.height > 0 ? it.height : 0) ||
              Math.hypot(t[2] ?? 0, t[3] ?? 0),
            fontName,
          });
        }
        const fonts = readFontMetas(
          page as unknown as Parameters<typeof readFontMetas>[0],
          tc.styles as Parameters<typeof readFontMetas>[1],
          names,
        );
        const blocks = groupIntoBlocks(items, fonts, i - 1);

        // 取色:在位图上按块取文字色和底色(遮盖用底色才不会留白块)
        const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        const renderScale = canvas.width / vp1.width;
        const uiBlocks: UiBlock[] = blocks.map((b) => {
          const box = blockBox(b, 0);
          const [px1, py1] = applyMat(vp1.transform as unknown as Mat, box.x, box.y);
          const [px2, py2] = applyMat(vp1.transform as unknown as Mat, box.x + box.w, box.y + box.h);
          const colors = sampleColors(imgData, canvas.width, canvas.height, {
            x: Math.min(px1, px2) * renderScale,
            y: Math.min(py1, py2) * renderScale,
            w: Math.abs(px2 - px1) * renderScale,
            h: Math.abs(py2 - py1) * renderScale,
          });
          return { ...b, ink: colors.ink, bg: colors.bg };
        });

        const render: PageRender = {
          src: i - 1,
          dataUrl: canvas.toDataURL("image/jpeg", 0.92),
          vpW: vp1.width,
          vpH: vp1.height,
          transform: vp1.transform as unknown as Mat,
          srcRotate: ((page.rotate % 360) + 360) % 360,
          blocks: uiBlocks,
        };
        if (loadTokenRef.current !== token) return;
        setRenders((prev) => new Map(prev).set(render.src, render));
        setDoc((prev) => ({ ...prev, pages: [...prev.pages, { src: i - 1, rotate: 0 }] }));
        setProgress({ done: i, total: pdf.numPages });
        page.cleanup();
      }
      setProgress(null);
    } catch (e) {
      console.error("[pdf-tools] 打开 PDF 失败", e);
      if (loadTokenRef.current === token) {
        setError(
          /password/i.test(String(e))
            ? "PDF 已加密,请先解除密码保护再编辑。"
            : "无法打开这个 PDF,请确认文件未损坏。",
        );
        setProgress(null);
      }
    } finally {
      if (loadTokenRef.current === token) setLoading(false);
    }
  };

  /* --- 查找 --- */
  const blockIndex = useMemo(() => {
    const map = new Map<string, UiBlock>();
    for (const r of renders.values()) for (const b of r.blocks) map.set(b.id, b);
    return map;
  }, [renders]);

  const selectedBlock = selected?.kind === "block" ? blockIndex.get(selected.id) : undefined;
  const selectedAnno =
    selected?.kind === "anno" ? doc.annos.find((a) => a.id === selected.id) : undefined;

  /** 某段原文的当前状态(没改过就用原始值)。 */
  const editOf = useCallback(
    (b: UiBlock): BlockEdit => {
      const hit = doc.edits[b.id];
      if (hit) return hit;
      return {
        text: b.text,
        size: b.size,
        bold: b.bold,
        italic: b.italic,
        family: b.family,
        color: rgbToCss(b.ink),
        bg: rgbToCss(b.bg),
        fit: false,
      };
    },
    [doc.edits],
  );

  const isDirty = useCallback(
    (b: UiBlock) => {
      const e = doc.edits[b.id];
      if (!e) return false;
      return (
        e.text !== b.text ||
        Math.abs(e.size - b.size) > 0.01 ||
        e.bold !== b.bold ||
        e.italic !== b.italic ||
        e.family !== b.family ||
        e.color !== rgbToCss(b.ink) ||
        e.fit
      );
    },
    [doc.edits],
  );

  const dirtyCount = useMemo(
    () => [...blockIndex.values()].filter((b) => isDirty(b)).length,
    [blockIndex, isDirty],
  );

  const setEdit = useCallback(
    (b: UiBlock, patch: Partial<BlockEdit>) => {
      const base = editOf(b);
      mutate((prev) => ({ ...prev, edits: { ...prev.edits, [b.id]: { ...base, ...patch } } }));
    },
    [editOf, mutate],
  );

  const resetBlock = useCallback(
    (id: string) =>
      mutate((prev) => {
        if (!prev.edits[id]) return prev;
        const next = { ...prev.edits };
        delete next[id];
        return { ...prev, edits: next };
      }),
    [mutate],
  );

  const patchAnno = useCallback(
    (id: string, patch: Partial<Anno>) =>
      mutate((prev) => ({
        ...prev,
        annos: prev.annos.map((a) => (a.id === id ? ({ ...a, ...patch } as Anno) : a)),
      })),
    [mutate],
  );

  const removeAnno = useCallback(
    (id: string) => {
      mutate((prev) => ({ ...prev, annos: prev.annos.filter((a) => a.id !== id) }));
      setSelected(null);
    },
    [mutate],
  );

  /* --- 页面交互 --- */
  const dragRef = useRef<{
    kind: "move" | "resize" | "draw";
    annoId?: string;
    src: number;
    startPt: { x: number; y: number };
    orig?: Anno;
    box: { left: number; top: number; width: number; height: number };
    totalRotate: number;
    drew?: boolean;
  } | null>(null);
  const [drawPreview, setDrawPreview] = useState<
    | { src: number; x: number; y: number; w: number; h: number; kind: "whiteout" | "highlight" }
    | null
  >(null);
  const suppressClickRef = useRef(false);

  const pageGeom = (el: HTMLElement, slot: PageSlot, render: PageRender) => {
    const box = el.getBoundingClientRect();
    return {
      box: { left: box.left, top: box.top, width: box.width, height: box.height },
      totalRotate: (render.srcRotate + slot.rotate) % 360,
    };
  };

  const onPagePointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    slot: PageSlot,
    render: PageRender,
  ) => {
    if (tool !== "whiteout" && tool !== "highlight") return;
    const el = e.currentTarget;
    const { box, totalRotate } = pageGeom(el, slot, render);
    const startPt = screenToPt(render, totalRotate, box, e.clientX, e.clientY);
    dragRef.current = { kind: "draw", src: render.src, startPt, box, totalRotate };
    setDrawPreview({ src: render.src, x: startPt.x, y: startPt.y, w: 0, h: 0, kind: tool });
    try {
      // 捕获指针,拖到页面外也能继续收到 move;拿不到就退化成普通拖拽,别让整个拖框失效
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* 忽略 */
    }
    e.preventDefault();
  };

  const onPagePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d || d.kind !== "draw") return;
    const render = renders.get(d.src);
    if (!render) return;
    const now = screenToPt(render, d.totalRotate, d.box, e.clientX, e.clientY);
    d.drew = true;
    setDrawPreview({
      src: d.src,
      x: Math.min(d.startPt.x, now.x),
      y: Math.min(d.startPt.y, now.y),
      w: Math.abs(now.x - d.startPt.x),
      h: Math.abs(now.y - d.startPt.y),
      kind: (tool === "highlight" ? "highlight" : "whiteout") as "whiteout" | "highlight",
    });
  };

  const onPagePointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    const preview = drawPreview;
    setDrawPreview(null);
    if (!d || d.kind !== "draw" || !preview) return;
    if (preview.w < 2 || preview.h < 2) return;
    const id = uid();
    const anno: Anno =
      preview.kind === "highlight"
        ? {
            id,
            kind: "highlight",
            page: preview.src,
            x: preview.x,
            y: preview.y,
            w: preview.w,
            h: preview.h,
            color: HIGHLIGHT_COLOR,
          }
        : {
            id,
            kind: "whiteout",
            page: preview.src,
            x: preview.x,
            y: preview.y,
            w: preview.w,
            h: preview.h,
            color: "#ffffff",
          };
    mutate((prev) => ({ ...prev, annos: [...prev.annos, anno] }));
    setSelected({ kind: "anno", id });
    suppressClickRef.current = true;
  };

  const onPageClick = (
    e: React.MouseEvent<HTMLDivElement>,
    slot: PageSlot,
    render: PageRender,
  ) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    const { box, totalRotate } = pageGeom(e.currentTarget, slot, render);
    const pt = screenToPt(render, totalRotate, box, e.clientX, e.clientY);
    if (tool === "text") {
      const id = uid();
      mutate((prev) => ({
        ...prev,
        annos: [
          ...prev.annos,
          {
            id,
            kind: "text",
            page: render.src,
            x: pt.x,
            baseline: pt.y,
            text: "",
            size: 11,
            family: "sans",
            bold: false,
            italic: false,
            color: "#1a1a1a",
          },
        ],
      }));
      setSelected({ kind: "anno", id });
      setTool("select");
      return;
    }
    if (tool === "image" && pendingImage) {
      const id = uid();
      const w = render.vpW * 0.25;
      const h = w * pendingImage.aspect;
      mutate((prev) => ({
        ...prev,
        annos: [
          ...prev.annos,
          {
            id,
            kind: "image",
            page: render.src,
            x: pt.x - w / 2,
            y: pt.y - h / 2,
            w,
            h,
            dataUrl: pendingImage.dataUrl,
            aspect: pendingImage.aspect,
          },
        ],
      }));
      setSelected({ kind: "anno", id });
      setPendingImage(null);
      setTool("select");
      return;
    }
    setSelected(null);
  };

  /** 拖动 / 缩放已有的标注。 */
  const startAnnoDrag = (
    e: React.PointerEvent,
    anno: Anno,
    mode: "move" | "resize",
    slot: PageSlot,
    render: PageRender,
  ) => {
    e.stopPropagation();
    e.preventDefault();
    const pageEl = (e.currentTarget as HTMLElement).closest("[data-page-surface]") as HTMLElement | null;
    if (!pageEl) return;
    const { box, totalRotate } = pageGeom(pageEl, slot, render);
    const startPt = screenToPt(render, totalRotate, box, e.clientX, e.clientY);
    dragRef.current = { kind: mode, annoId: anno.id, src: render.src, startPt, orig: anno, box, totalRotate };
    setSelected({ kind: "anno", id: anno.id });
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d || !d.orig) return;
      const r = renders.get(d.src);
      if (!r) return;
      const now = screenToPt(r, d.totalRotate, d.box, ev.clientX, ev.clientY);
      const dx = now.x - d.startPt.x;
      const dy = now.y - d.startPt.y;
      d.drew = true;
      const orig = d.orig;
      setDoc((prev) => ({
        ...prev,
        annos: prev.annos.map((a) => {
          if (a.id !== orig.id) return a;
          if (d.kind === "move") {
            if (a.kind === "text" && orig.kind === "text") {
              return { ...a, x: orig.x + dx, baseline: orig.baseline + dy };
            }
            if (orig.kind !== "text" && a.kind !== "text") {
              return { ...a, x: orig.x + dx, y: orig.y + dy };
            }
            return a;
          }
          // resize
          if (a.kind === "text" && orig.kind === "text") {
            return { ...a, size: Math.min(Math.max(orig.size + dx * 0.5, 5), 96) };
          }
          if (orig.kind !== "text" && a.kind !== "text") {
            if (a.kind === "image" && orig.kind === "image") {
              const w = Math.max(orig.w + dx, 8);
              return { ...a, x: orig.x, y: orig.y + orig.h - w * orig.aspect, w, h: w * orig.aspect };
            }
            const w = Math.max(orig.w + dx, 4);
            const h = Math.max(orig.h - dy, 4);
            return { ...a, w, h, y: orig.y + dy };
          }
          return a;
        }),
      }));
    };
    const up = () => {
      const d = dragRef.current;
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (d?.drew) {
        suppressClickRef.current = true;
        // 拖动结束才记一步历史(否则每一帧都进历史)
        const before = d.orig;
        if (before) {
          pastRef.current = [
            ...pastRef.current.slice(-49),
            { ...doc, annos: doc.annos.map((a) => (a.id === before.id ? before : a)) },
          ];
          futureRef.current = [];
          syncHist();
        }
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  /* --- 导出 --- */
  const buildItems = (): EditItem[] => {
    const items: EditItem[] = [];
    for (const b of blockIndex.values()) {
      if (!isDirty(b)) continue;
      const e = editOf(b);
      const box = blockBox(b);
      items.push({
        kind: "rect",
        page: b.page,
        x: box.x,
        y: box.y,
        w: box.w,
        h: box.h,
        color: cssToRgb(e.bg),
      });
      if (e.text.trim()) {
        items.push({
          kind: "text",
          page: b.page,
          x: b.x,
          baseline: b.baseline,
          text: e.text,
          size: e.size,
          font: fontKeyFor(e.family, e.bold, e.italic),
          color: cssToRgb(e.color),
          fitWidth: e.fit ? b.width : undefined,
        });
      }
    }
    for (const a of doc.annos) {
      if (a.kind === "text") {
        if (!a.text.trim()) continue;
        items.push({
          kind: "text",
          page: a.page,
          x: a.x,
          baseline: a.baseline,
          text: a.text,
          size: a.size,
          font: fontKeyFor(a.family, a.bold, a.italic),
          color: cssToRgb(a.color),
        });
      } else if (a.kind === "image") {
        items.push({ kind: "image", page: a.page, x: a.x, y: a.y, w: a.w, h: a.h, dataUrl: a.dataUrl });
      } else {
        items.push({
          kind: "rect",
          page: a.page,
          x: a.x,
          y: a.y,
          w: a.w,
          h: a.h,
          color: cssToRgb(a.color),
          opacity: a.kind === "highlight" ? 0.4 : 1,
        });
      }
    }
    return items;
  };

  /** 需要「彻底移除原文字」的源页:被改写过、或被涂白盖住的页。 */
  const pagesNeedingFlatten = useMemo(() => {
    const set = new Set<number>();
    for (const b of blockIndex.values()) if (isDirty(b)) set.add(b.page);
    for (const a of doc.annos) if (a.kind === "whiteout") set.add(a.page);
    return set;
  }, [blockIndex, isDirty, doc.annos]);

  /** 扁平化用的高清位图:必须按 rotation: 0 渲染,坐标系才和 items 一致。 */
  const renderFlat = async (src: number): Promise<string> => {
    const pdf = pdfDocRef.current;
    if (!pdf) throw new Error("PDF 未就绪");
    const page = (await pdf.getPage(src + 1)) as {
      getViewport(o: { scale: number; rotation: number }): { width: number; height: number };
      render(o: object): { promise: Promise<void> };
      cleanup(): void;
    };
    const vp = page.getViewport({ scale: FLATTEN_SCALE, rotation: 0 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
    page.cleanup();
    return canvas.toDataURL("image/jpeg", 0.95);
  };

  const exportPdf = async () => {
    if (!bytesRef.current || exporting) return;
    setExporting(true);
    setError(null);
    setNotice(null);
    try {
      const items = buildItems();
      const pages = [];
      for (const slot of doc.pages) {
        const needFlat = flatten && pagesNeedingFlatten.has(slot.src);
        pages.push({
          src: slot.src,
          rotate: slot.rotate,
          flattenDataUrl: needFlat ? await renderFlat(slot.src) : undefined,
        });
      }
      const plan: EditPlan = { pages, items };
      const out = await applyPdfEdits(bytesRef.current.slice(0), plan, {
        loadUnicodeFont,
        loadFontkit: () => import("fontkit"),
      });
      download(out, (fileName || "document.pdf").replace(/\.pdf$/i, "") + "-edited.pdf");
      setNotice(
        `已导出${flatten && pagesNeedingFlatten.size > 0 ? `(其中 ${pagesNeedingFlatten.size} 页已扁平化,被遮盖的原文字已彻底移除)` : ""}。`,
      );
    } catch (e) {
      console.error("[pdf-tools] 导出失败", e);
      setError(e instanceof Error ? `导出失败:${e.message}` : "导出失败,请重试。");
    } finally {
      setExporting(false);
    }
  };

  const changeCount = dirtyCount + doc.annos.length;
  const pageChanged =
    doc.pages.length !== renders.size ||
    doc.pages.some((p, i) => p.src !== i || p.rotate !== 0);

  /* ========== 渲染 ========== */

  return (
    <div>
      {/* ① 选择文件 */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-800">① 选择要编辑的 PDF</h2>
        <p className="mt-1 text-xs text-slate-400">
          文件全程在浏览器本地处理,不会上传到任何服务器。
        </p>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void openPdf(f);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="mt-3 w-full rounded-xl border-2 border-dashed border-slate-200 px-4 py-6 text-sm text-slate-500 transition hover:border-indigo-300 hover:text-indigo-600"
        >
          {loading
            ? progress
              ? `正在解析第 ${progress.done} / ${progress.total} 页…`
              : "正在打开…"
            : fileName
              ? `已打开:${fileName}(点击可更换)`
              : "点击选择 PDF 文件"}
        </button>
        {error && <p className="mt-3 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-600">{error}</p>}
        {notice && (
          <p className="mt-3 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>
        )}
      </div>

      {doc.pages.length > 0 && (
        <>
          {/* ② 工具栏 */}
          <div className="sticky top-0 z-20 mt-5 rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-sm backdrop-blur">
            <div className="flex flex-wrap items-center gap-2">
              {(
                [
                  ["select", "✋ 选择 / 改字"],
                  ["text", "＋ 加文字"],
                  ["whiteout", "🩹 涂白遮盖"],
                  ["highlight", "🖍 高亮"],
                  ["image", "🖼 插图片"],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => {
                    setTool(key);
                    setSelected(null);
                    if (key === "image") imgRef.current?.click();
                    else setPendingImage(null);
                  }}
                  className={`rounded-xl px-3 py-2 text-xs font-semibold transition ${
                    tool === key
                      ? "bg-indigo-500 text-white shadow-sm"
                      : "border border-slate-200 bg-white text-slate-600 hover:border-indigo-300"
                  }`}
                >
                  {label}
                </button>
              ))}
              <input
                ref={imgRef}
                type="file"
                accept="image/png,image/jpeg"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (!f) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    const dataUrl = String(reader.result);
                    const img = new Image();
                    img.onload = () => {
                      setPendingImage({ dataUrl, aspect: img.height / img.width });
                      setTool("image");
                    };
                    img.src = dataUrl;
                  };
                  reader.readAsDataURL(f);
                }}
              />

              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={undo}
                  disabled={histLen.past === 0}
                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-500 hover:border-slate-300 disabled:opacity-40"
                  title="撤销 (⌘Z)"
                >
                  ↶ 撤销
                </button>
                <button
                  onClick={redo}
                  disabled={histLen.future === 0}
                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs text-slate-500 hover:border-slate-300 disabled:opacity-40"
                  title="重做 (⇧⌘Z)"
                >
                  ↷ 重做
                </button>
                <button
                  onClick={exportPdf}
                  disabled={exporting || (changeCount === 0 && !pageChanged)}
                  className="rounded-xl bg-indigo-500 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {exporting ? "正在合成…" : "导出编辑版 PDF"}
                </button>
              </div>
            </div>

            <p className="mt-2 text-xs text-slate-400">
              {tool === "select" && "点页面上的任意一段文字 → 直接改写或删掉它;标注可拖动、拖右下角缩放。"}
              {tool === "text" && "点页面上想插入文字的位置(支持中文)。"}
              {tool === "whiteout" && "在页面上按住拖出一个框,用底色盖掉里面的内容。"}
              {tool === "highlight" && "在页面上按住拖出一个框,加半透明黄色高亮。"}
              {tool === "image" &&
                (pendingImage ? "已选好图片,点页面上想放的位置。" : "先选一张图片(PNG/JPG)。")}
            </p>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-100 pt-3 text-xs">
              <span className="text-slate-400">
                改写 {dirtyCount} 段 · 标注 {doc.annos.length} 项 · 共 {doc.pages.length} 页
              </span>
              <label className="flex items-center gap-1.5 text-slate-600">
                <input
                  type="checkbox"
                  checked={flatten}
                  onChange={(e) => setFlatten(e.target.checked)}
                  className="accent-indigo-500"
                />
                彻底移除被遮盖的原文字(把改过的页转成图片)
              </label>
              {!flatten && pagesNeedingFlatten.size > 0 && (
                <span className="rounded-lg bg-amber-50 px-2 py-1 text-amber-700">
                  ⚠️ 不勾选时,遮盖只是视觉遮挡,原文字仍能被复制/搜索到
                </span>
              )}
            </div>
          </div>

          {/* ③ 选中项的属性 */}
          {(selectedBlock || selectedAnno) && (
            <div className="sticky top-[132px] z-10 mt-3 rounded-2xl border border-indigo-200 bg-indigo-50/80 p-4 shadow-sm backdrop-blur">
              {selectedBlock && (
                <BlockPanel
                  block={selectedBlock}
                  edit={editOf(selectedBlock)}
                  dirty={isDirty(selectedBlock)}
                  onChange={(patch) => setEdit(selectedBlock, patch)}
                  onReset={() => resetBlock(selectedBlock.id)}
                  onClose={() => setSelected(null)}
                />
              )}
              {selectedAnno && (
                <AnnoPanel
                  anno={selectedAnno}
                  onChange={(patch) => patchAnno(selectedAnno.id, patch)}
                  onRemove={() => removeAnno(selectedAnno.id)}
                  onClose={() => setSelected(null)}
                />
              )}
            </div>
          )}

          {/* ④ 页面 */}
          <div ref={listRef} className="mt-5 space-y-8">
            {doc.pages.map((slot, slotIdx) => {
              const render = renders.get(slot.src);
              if (!render) return null;
              const totalRotate = (render.srcRotate + slot.rotate) % 360;
              const swapped = totalRotate === 90 || totalRotate === 270;
              const displayW = boxW;
              const displayH = (boxW * render.vpH) / render.vpW;
              // 旋转 90/270 时,外层要按换过的宽高留位置
              const outerH = swapped ? (displayW * render.vpW) / render.vpH : displayH;
              const scaleFit = swapped ? Math.min(1, displayW / displayH) : 1;
              // 覆盖层里的 px 是「未旋转、未缩放」元素里的尺寸,外层的 scale() 会自动跟着缩,
              // 所以这里不能再乘 scaleFit(乘了字会小一圈)
              const fontScale = boxW / render.vpW;

              return (
                <div key={`${slot.src}-${slotIdx}`}>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-slate-500">
                      第 {slotIdx + 1} / {doc.pages.length} 页
                      <span className="ml-1 text-slate-300">(原第 {slot.src + 1} 页)</span>
                    </span>
                    <div className="flex gap-1">
                      {(
                        [
                          ["⟲", "逆时针旋转", () => mutate((p) => ({ ...p, pages: rotatePageSlot(p.pages, slotIdx, -90) }))],
                          ["⟳", "顺时针旋转", () => mutate((p) => ({ ...p, pages: rotatePageSlot(p.pages, slotIdx, 90) }))],
                          ["↑", "上移一页", () => mutate((p) => ({ ...p, pages: movePageSlot(p.pages, slotIdx, -1) }))],
                          ["↓", "下移一页", () => mutate((p) => ({ ...p, pages: movePageSlot(p.pages, slotIdx, 1) }))],
                        ] as const
                      ).map(([icon, title, fn]) => (
                        <button
                          key={title}
                          title={title}
                          onClick={fn}
                          className="h-7 w-7 rounded-lg border border-slate-200 bg-white text-xs text-slate-500 hover:border-indigo-300 hover:text-indigo-600"
                        >
                          {icon}
                        </button>
                      ))}
                      <button
                        title="删除这一页"
                        onClick={() => mutate((p) => ({ ...p, pages: deletePageSlot(p.pages, slotIdx) }))}
                        disabled={doc.pages.length <= 1}
                        className="h-7 w-7 rounded-lg border border-slate-200 bg-white text-xs text-rose-400 hover:border-rose-300 hover:text-rose-600 disabled:opacity-40"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* 外层负责旋转后的占位;内层是「未旋转」的坐标系 */}
                  <div className="relative w-full" style={{ height: outerH }}>
                    <div
                      data-page-surface
                      onPointerDown={(e) => onPagePointerDown(e, slot, render)}
                      onPointerMove={onPagePointerMove}
                      onPointerUp={onPagePointerUp}
                      onClick={(e) => onPageClick(e, slot, render)}
                      className={`absolute overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm ${
                        tool === "whiteout" || tool === "highlight"
                          ? "cursor-crosshair"
                          : tool === "text" || (tool === "image" && pendingImage)
                            ? "cursor-copy"
                            : ""
                      }`}
                      style={{
                        width: displayW,
                        height: displayH,
                        left: "50%",
                        top: "50%",
                        transform: `translate(-50%, -50%) rotate(${totalRotate}deg) scale(${scaleFit})`,
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={render.dataUrl}
                        alt={`第 ${slotIdx + 1} 页`}
                        className="block h-full w-full select-none"
                        draggable={false}
                      />

                      {/* 原文文字块:可点选改写。
                          这里不做「只画视野内的页」的优化 —— 试过用 IntersectionObserver 按需渲染,
                          但它在标签页隐藏时会先报一次「都不可见」,把所有块撤掉,
                          用户回到前台前编辑器里一段都点不动。块本身只是空 div,几千个也还好。 */}
                      {tool === "select" &&
                        render.blocks.map((b) => {
                          const e = doc.edits[b.id];
                          const dirty = isDirty(b);
                          const pct = rectToPct(render, blockBox(b));
                          const isSel = selected?.kind === "block" && selected.id === b.id;
                          const view = e ?? null;
                          return (
                            <div
                              key={b.id}
                              onClick={(ev) => {
                                ev.stopPropagation();
                                setSelected({ kind: "block", id: b.id });
                              }}
                              title={b.text}
                              className={`absolute cursor-text ${
                                isSel
                                  ? "outline outline-2 outline-indigo-500"
                                  : dirty
                                    ? "outline outline-1 outline-emerald-400"
                                    : "hover:outline hover:outline-1 hover:outline-indigo-300"
                              }`}
                              style={{
                                left: `${pct.left}%`,
                                top: `${pct.top}%`,
                                width: `${pct.width}%`,
                                height: `${pct.height}%`,
                                backgroundColor: dirty ? view?.bg ?? "#fff" : undefined,
                              }}
                            >
                              {dirty && view && (
                                <span
                                  className="pointer-events-none absolute whitespace-pre"
                                  style={{
                                    left: 0,
                                    bottom: `${((-(b.descent || -0.22) * b.size) / blockBox(b).h) * 100}%`,
                                    fontSize: view.size * fontScale,
                                    lineHeight: 1,
                                    color: view.color,
                                    fontFamily: cssFontFamily(view.family),
                                    fontWeight: view.bold ? 700 : 400,
                                    fontStyle: view.italic ? "italic" : "normal",
                                  }}
                                >
                                  {view.text}
                                </span>
                              )}
                            </div>
                          );
                        })}

                      {/* 标注 */}
                      {doc.annos
                        .filter((a) => a.page === render.src)
                        .map((a) => {
                          const isSel = selected?.kind === "anno" && selected.id === a.id;
                          if (a.kind === "text") {
                            const [vx, vy] = applyMat(render.transform, a.x, a.baseline);
                            return (
                              <div
                                key={a.id}
                                onPointerDown={(e) => startAnnoDrag(e, a, "move", slot, render)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelected({ kind: "anno", id: a.id });
                                }}
                                className={`absolute cursor-move whitespace-pre ${
                                  isSel ? "outline outline-2 outline-indigo-500" : "hover:outline hover:outline-1 hover:outline-indigo-300"
                                }`}
                                style={{
                                  left: `${(vx / render.vpW) * 100}%`,
                                  top: `${(vy / render.vpH) * 100}%`,
                                  transform: "translateY(-78%)",
                                  fontSize: a.size * fontScale,
                                  lineHeight: 1.2,
                                  color: a.color,
                                  fontFamily: cssFontFamily(a.family),
                                  fontWeight: a.bold ? 700 : 400,
                                  fontStyle: a.italic ? "italic" : "normal",
                                }}
                              >
                                {a.text || "(空文本)"}
                                {isSel && (
                                  <span
                                    onPointerDown={(e) => startAnnoDrag(e, a, "resize", slot, render)}
                                    className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border border-white bg-indigo-500"
                                  />
                                )}
                              </div>
                            );
                          }
                          const pct = rectToPct(render, a);
                          return (
                            <div
                              key={a.id}
                              onPointerDown={(e) => startAnnoDrag(e, a, "move", slot, render)}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelected({ kind: "anno", id: a.id });
                              }}
                              className={`absolute cursor-move ${
                                isSel ? "outline outline-2 outline-indigo-500" : "hover:outline hover:outline-1 hover:outline-indigo-300"
                              }`}
                              style={{
                                left: `${pct.left}%`,
                                top: `${pct.top}%`,
                                width: `${pct.width}%`,
                                height: `${pct.height}%`,
                                backgroundColor: a.kind === "image" ? undefined : a.color,
                                opacity: a.kind === "highlight" ? 0.4 : 1,
                              }}
                            >
                              {a.kind === "image" && (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={a.dataUrl} alt="插入的图片" className="block h-full w-full" draggable={false} />
                              )}
                              {isSel && (
                                <span
                                  onPointerDown={(e) => startAnnoDrag(e, a, "resize", slot, render)}
                                  className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border border-white bg-indigo-500"
                                />
                              )}
                            </div>
                          );
                        })}

                      {/* 拖框预览 */}
                      {drawPreview && drawPreview.src === render.src && (
                        <div
                          className="pointer-events-none absolute border border-indigo-400"
                          style={{
                            ...(() => {
                              const p = rectToPct(render, drawPreview);
                              return {
                                left: `${p.left}%`,
                                top: `${p.top}%`,
                                width: `${p.width}%`,
                                height: `${p.height}%`,
                              };
                            })(),
                            backgroundColor: drawPreview.kind === "highlight" ? HIGHLIGHT_COLOR : "#ffffff",
                            opacity: drawPreview.kind === "highlight" ? 0.4 : 0.85,
                          }}
                        />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

/* ========== 属性面板 ========== */

function ColorRow({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      {TEXT_COLORS.map((c) => (
        <button
          key={c}
          onClick={() => onChange(c)}
          className={`h-5 w-5 rounded-full border-2 ${
            value.toLowerCase() === c ? "border-indigo-500" : "border-slate-300"
          }`}
          style={{ backgroundColor: c }}
          aria-label={c}
        />
      ))}
      <input
        type="color"
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : "#1a1a1a"}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 w-8 cursor-pointer rounded border border-slate-300 bg-white"
        aria-label="自定义颜色"
      />
    </div>
  );
}

function StyleControls({
  size,
  bold,
  italic,
  family,
  color,
  onChange,
}: {
  size: number;
  bold: boolean;
  italic: boolean;
  family: Family;
  color: string;
  onChange: (patch: { size?: number; bold?: boolean; italic?: boolean; family?: Family; color?: string }) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <label className="flex items-center gap-1 text-slate-600">
        字号
        <input
          type="number"
          min={4}
          max={96}
          step={0.5}
          value={size}
          onChange={(e) => onChange({ size: Math.min(Math.max(Number(e.target.value) || 1, 4), 96) })}
          className="w-16 rounded-lg border border-slate-300 px-2 py-1"
        />
      </label>
      <button
        onClick={() => onChange({ bold: !bold })}
        className={`h-7 w-7 rounded-lg border font-bold ${
          bold ? "border-indigo-500 bg-indigo-500 text-white" : "border-slate-300 bg-white text-slate-600"
        }`}
      >
        B
      </button>
      <button
        onClick={() => onChange({ italic: !italic })}
        className={`h-7 w-7 rounded-lg border italic ${
          italic ? "border-indigo-500 bg-indigo-500 text-white" : "border-slate-300 bg-white text-slate-600"
        }`}
      >
        I
      </button>
      <select
        value={family}
        onChange={(e) => onChange({ family: e.target.value as Family })}
        className="rounded-lg border border-slate-300 bg-white px-2 py-1 text-slate-600"
      >
        <option value="sans">无衬线 Helvetica</option>
        <option value="serif">衬线 Times</option>
        <option value="mono">等宽 Courier</option>
      </select>
      <ColorRow value={color} onChange={(c) => onChange({ color: c })} />
    </div>
  );
}

function BlockPanel({
  block,
  edit,
  dirty,
  onChange,
  onReset,
  onClose,
}: {
  block: UiBlock;
  edit: BlockEdit;
  dirty: boolean;
  onChange: (patch: Partial<BlockEdit>) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  // 粗估宽度用来提醒「会不会压到右边」;导出时按真实字体度量算,所以这里不必精确
  const estimated = estimateWidthPt(edit.text, edit.size);
  const tooWide = estimated > block.width * 1.08 && block.width > 4;

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-indigo-700">
            改写这段文字
            <span className="ml-2 font-normal text-indigo-400">
              原文:{block.text.length > 40 ? block.text.slice(0, 40) + "…" : block.text}
            </span>
          </p>
          <textarea
            value={edit.text}
            onChange={(e) => onChange({ text: e.target.value })}
            rows={Math.min(4, edit.text.split("\n").length)}
            autoFocus
            placeholder="清空 = 只把原文遮掉"
            className="mt-2 w-full rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
          />
        </div>
        <button onClick={onClose} className="text-xs text-indigo-400 hover:text-indigo-600">
          收起
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <StyleControls
          size={edit.size}
          bold={edit.bold}
          italic={edit.italic}
          family={edit.family}
          color={edit.color}
          onChange={(patch) => onChange(patch)}
        />
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          遮盖底色
          <input
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(edit.bg) ? edit.bg : "#ffffff"}
            onChange={(e) => onChange({ bg: e.target.value })}
            className="h-6 w-8 cursor-pointer rounded border border-slate-300 bg-white"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={edit.fit}
            onChange={(e) => onChange({ fit: e.target.checked })}
            className="accent-indigo-500"
          />
          缩到原宽度内
        </label>
        {dirty && (
          <button
            onClick={onReset}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-500 hover:border-slate-400"
          >
            还原这段
          </button>
        )}
        <button
          onClick={() => onChange({ text: "" })}
          className="rounded-lg border border-rose-200 bg-white px-2.5 py-1 text-xs text-rose-500 hover:border-rose-300"
        >
          删掉这段字
        </button>
      </div>

      {tooWide && !edit.fit && (
        <p className="mt-2 text-xs text-amber-700">
          ⚠️ 新文字比原文宽(约 {Math.round(estimated)}pt vs {Math.round(block.width)}pt),可能压到右边的内容
          —— 可勾「缩到原宽度内」或把字号调小。
        </p>
      )}
    </div>
  );
}

function AnnoPanel({
  anno,
  onChange,
  onRemove,
  onClose,
}: {
  anno: Anno;
  onChange: (patch: Partial<Anno>) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const label =
    anno.kind === "text"
      ? "插入的文字"
      : anno.kind === "whiteout"
        ? "涂白遮盖"
        : anno.kind === "highlight"
          ? "高亮"
          : "插入的图片";
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-indigo-700">{label}</p>
          {anno.kind === "text" && (
            <textarea
              value={anno.text}
              onChange={(e) => onChange({ text: e.target.value })}
              rows={Math.min(4, Math.max(1, anno.text.split("\n").length))}
              autoFocus
              placeholder="输入文字(支持中文,换行会分多行)"
              className="mt-2 w-full rounded-xl border border-indigo-200 bg-white px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-400"
            />
          )}
        </div>
        <button onClick={onClose} className="text-xs text-indigo-400 hover:text-indigo-600">
          收起
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        {anno.kind === "text" && (
          <StyleControls
            size={anno.size}
            bold={anno.bold}
            italic={anno.italic}
            family={anno.family}
            color={anno.color}
            onChange={(patch) => onChange(patch as Partial<Anno>)}
          />
        )}
        {(anno.kind === "whiteout" || anno.kind === "highlight") && (
          <label className="flex items-center gap-1.5 text-xs text-slate-600">
            颜色
            <input
              type="color"
              value={/^#[0-9a-f]{6}$/i.test(anno.color) ? anno.color : "#ffffff"}
              onChange={(e) => onChange({ color: e.target.value })}
              className="h-6 w-8 cursor-pointer rounded border border-slate-300 bg-white"
            />
          </label>
        )}
        <button
          onClick={onRemove}
          className="rounded-lg border border-rose-200 bg-white px-2.5 py-1 text-xs text-rose-500 hover:border-rose-300"
        >
          删除这一项
        </button>
      </div>
    </div>
  );
}
