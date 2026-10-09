import { useEffect, useId, useRef, useState } from "react";
import { supplierText } from "./catalog-policy";

type Image = { src: string; alt: string };

export default function ProductImage({ image, name }: { image?: Image; name: string }) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const preview = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const title = supplierText(name);
  const unavailable = !image?.src || failedSource === image.src;

  function close() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    preview.current?.hidePopover();
  }

  function show() {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    const button = trigger.current;
    const popup = preview.current;
    if (!button || !popup || unavailable) return;
    const rect = button.getBoundingClientRect();
    const size = Math.min(280, window.innerWidth - 24, window.innerHeight - 24);
    const preferredLeft = rect.right + 12 + size <= window.innerWidth - 12
      ? rect.right + 12 : rect.left - size - 12;
    popup.style.width = `${size}px`;
    popup.style.height = `${size}px`;
    popup.style.left = `${Math.max(12, Math.min(preferredLeft, window.innerWidth - size - 12))}px`;
    popup.style.top = `${Math.max(12, Math.min(rect.top, window.innerHeight - size - 12))}px`;
    popup.showPopover();
  }

  useEffect(() => {
    if (!open) return;
    const popup = preview.current;
    const dismiss = () => popup?.hidePopover();
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

  function imageError() {
    console.warn("Supplier product image could not be loaded.");
    close();
    setOpen(false);
    setFailedSource(image?.src || null);
  }

  if (unavailable) {
    return <span className="product-image-placeholder">{image?.src ? "Image unavailable" : "No image"}</span>;
  }

  return <div className="product-image"
    onMouseEnter={show}
    onMouseLeave={(event) => {
      if (!event.currentTarget.contains(document.activeElement)) closeTimer.current = setTimeout(close, 150);
    }}
    onBlur={(event) => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) close();
    }}>
    <button ref={trigger} type="button" className="product-image-trigger"
      aria-label={`Show larger image of ${title}`} aria-expanded={open} aria-controls={id}
      aria-describedby={open ? id : undefined}
      onFocus={show} onClick={show}>
      <img src={image.src} alt="" width="48" height="48" loading="lazy" onError={imageError} />
    </button>
    <div ref={preview} id={id} popover="auto" className="product-image-preview"
      role="tooltip" onToggle={(event) => setOpen(event.newState === "open")}>
      {open && <img src={image.src} alt={supplierText(image.alt) || title} onError={imageError} />}
      <p>{title}</p>
    </div>
  </div>;
}
