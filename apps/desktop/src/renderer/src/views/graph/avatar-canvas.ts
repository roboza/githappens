import { avatarSrc } from '../../components/Avatar';

/**
 * Decoded avatar images for the graph canvas (spec 04 §6.5 "Renderer"): an LRU of up to 512 images
 * loaded from `githappens-avatar://` URLs. Until an image is ready the renderer draws initials; `onReady`
 * schedules a redraw when one finishes loading.
 */
export class CanvasAvatarCache {
  private readonly images = new Map<string, HTMLImageElement | null>();
  private onReady: () => void = () => undefined;

  constructor(private readonly max = 512) {}

  /** Called when an image finished loading (schedule a redraw). */
  setOnReady(fn: () => void): void {
    this.onReady = fn;
  }

  /** Ready image for an author email, or null (not available yet / no avatar → initials). */
  get(email: string, size: number): CanvasImageSource | null {
    const url = avatarSrc({ email }, size);
    if (!url) return null;
    let img = this.images.get(url);
    if (img === undefined) {
      img = new Image();
      img.decoding = 'async';
      const el = img;
      el.onload = () => this.onReady();
      el.onerror = () => this.images.set(url, null);
      el.src = url;
      this.images.set(url, el);
      while (this.images.size > this.max) this.images.delete(this.images.keys().next().value!);
    } else {
      // LRU touch
      this.images.delete(url);
      this.images.set(url, img);
    }
    return img && img.complete && img.naturalWidth > 0 ? img : null;
  }

  clear(): void {
    this.images.clear();
  }
}
