import type { Metadata } from "next";
import Link from "next/link";
import { DesktopDownloads } from "@/components/desktop-downloads";
import "./download.css";

export const metadata: Metadata = {
  title: "Download alto",
  description: "Download the alto desktop app with the bundled alto SSH command.",
};

export default function DownloadPage() {
  return <div className="desktop-download-page">
    <header className="desktop-download-header">
      <Link className="desktop-download-brand" href="/" aria-label="alto home">alto<span aria-hidden="true">.</span></Link>
      <Link className="button" href="/app">Open portal</Link>
    </header>
    <main className="desktop-download-main">
      <div className="desktop-download-intro"><p className="desktop-download-eyebrow">alto for desktop</p><h1>Your agents, close at hand.</h1><p>Pick up your project conversations and connect to your remote environments. The alto SSH command comes with the app.</p></div>
      <DesktopDownloads />
      <section className="desktop-download-setup" aria-labelledby="desktop-install-title">
        <h2 id="desktop-install-title">Get started on macOS</h2>
        <ol>
          <li><strong>Install alto.</strong> Open the DMG and drag alto into Applications.</li>
          <li><strong>Open the app and sign in.</strong> Use the same account and server as your portal, then select your project and environment.</li>
          <li><strong>Add the terminal command.</strong> Run this once after installing the app:<pre><code>/Applications/alto.app/Contents/Resources/bin/alto install</code></pre>If prompted, add <code>~/.local/bin</code> to your PATH and open a new terminal.</li>
          <li><strong>Connect to your environment.</strong> Keep alto open and signed in, then run:<pre><code>alto ssh &lt;environment-id&gt;</code></pre>Use the environment ID from the portal. The helper registers your device key and checks the environment&apos;s host identity. SSH grants trusted shell access.</li>
        </ol>
      </section>
    </main>
  </div>;
}
