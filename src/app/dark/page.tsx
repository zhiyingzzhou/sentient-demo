import Link from 'next/link';
import styles from './page.module.css';

export default function DarkBackgroundPage() {
  return (
    <div className={styles.page}>
      <main className={styles.main}>
        <div className={styles.toolbar}>
          <div className={styles.pill}>
            <span>BackgroundCanvas</span>
            <span style={{ opacity: 0.65 }}>·</span>
            <span style={{ opacity: 0.8 }}>base: #000</span>
          </div>

          <div className={styles.pill}>
            <Link className={styles.link} href="/">
              返回首页
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}

