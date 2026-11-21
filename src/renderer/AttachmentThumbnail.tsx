import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MessageAttachment } from '../shared/types';
import { queueThumbnail } from './thumbnail-queue';

/**
 * An attachment's slot in the activity card: an image shows its own thumbnail,
 * center-cropped to a square by CSS (`object-fit: cover`). The thumbnail is
 * fetched only once the entry is on screen, shares the chat's two thumbnail
 * slots, and comes from a bounded, cached encoder (embedded images on this
 * computer, files on their machine). Until then, and whenever it cannot be
 * shown (error, unsupported format, oversize), `icon` stays in its place.
 */
export function AttachmentThumbnail({ workspaceId, sessionId, file, icon }: {
  workspaceId: string; sessionId?: string; file: MessageAttachment; icon: ReactNode;
}) {
  const slot = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!file.image || !sessionId || !slot.current) return;
    let retired = false, created: string | undefined, cancel: (() => void) | undefined;
    // The implicit root is clipped by the card's own scrolling lists: hidden entries never load.
    const observer = new IntersectionObserver(entries => {
      if (retired) return;
      if (!entries.at(-1)?.isIntersecting) { cancel?.(); cancel = undefined; return; }
      cancel ??= queueThumbnail(async () => {
        observer.disconnect();
        try {
          const preview = await window.desktop.previewMessageAttachmentThumbnail(workspaceId, sessionId, file.id);
          if (retired || preview.kind !== 'image' || !preview.data) return;
          created = URL.createObjectURL(new Blob([new Uint8Array(preview.data)], { type: preview.mime }));
          setUrl(created);
        } catch { /* The icon stays; other thumbnails go on. */ }
      });
    });
    observer.observe(slot.current);
    return () => { retired = true; cancel?.(); observer.disconnect(); if (created) URL.revokeObjectURL(created); setUrl(''); };
  }, [workspaceId, sessionId, file.id, file.image, file.path, file.revision]);
  return <span ref={slot} className="activity-float-thumb" data-thumbnail={url ? 'image' : 'icon'}>
    {url ? <img src={url} alt="" draggable={false} onError={() => setUrl('')} /> : icon}
  </span>;
}
