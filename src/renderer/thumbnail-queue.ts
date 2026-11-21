type Load = () => Promise<void>;

/** 后台缩略图共用两个读取名额。原图由用户操作触发，不排在缩略图后面。 */
export function createThumbnailQueue(afterPaint: (drain: () => void) => void) {
  const waiting = new Set<Load>();
  let active = 0, scheduled = false;
  function schedule() {
    if (scheduled || active >= 2 || !waiting.size) return;
    scheduled = true;
    afterPaint(() => {
      scheduled = false;
      for (const job of waiting) {
        if (active >= 2) break;
        waiting.delete(job);
        active++;
        void (async () => {
          try { await job(); }
          finally { active--; schedule(); }
        })();
      }
    });
  }
  return (job: Load) => {
    waiting.add(job);
    schedule();
    return () => { waiting.delete(job); };
  };
}

// rAF 在绘制之前执行；跨一帧才给文字一次先绘制的机会。
export const queueThumbnail = createThumbnailQueue(drain => requestAnimationFrame(() => requestAnimationFrame(drain)));
