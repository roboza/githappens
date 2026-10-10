import markUrl from '../assets/logo-mark.svg';
import styles from './BrandLogo.module.css';

/** GitHappens branch glyph (assets/logo-mark.svg). */
export function BrandMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <img
      src={markUrl}
      width={size}
      height={size}
      alt=""
      aria-hidden
      draggable={false}
      className={`${styles.mark}${className ? ` ${className}` : ''}`}
    />
  );
}

/**
 * Glyph + "githappens" wordmark (assets/logo-wordmark.svg), as text so "git" follows the theme's
 * text colour (the SVG's near-white "git" is for dark backgrounds only).
 */
export function BrandWordmark({ size = 18, className }: { size?: number; className?: string }) {
  return (
    <span
      className={`${styles.wordmark}${className ? ` ${className}` : ''}`}
      style={{ fontSize: size }}
      role="img"
      aria-label="GitHappens"
    >
      <BrandMark size={Math.round(size * 1.25)} />
      <span aria-hidden>
        <span className={styles.git}>git</span>
        <span className={styles.happens}>happens</span>
      </span>
    </span>
  );
}
