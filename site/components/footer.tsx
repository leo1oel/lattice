import { Container } from "../ui";
import { Logo } from "./logo";
import type { Route } from "../use-route";

const REPO = "https://github.com/leo1oel/lattice";

export function Footer({ navigate }: { navigate: (r: Route) => void }) {
  return (
    <footer className="border-t border-border bg-surface">
      <Container className="flex flex-col gap-10 py-14 md:flex-row md:items-start md:justify-between">
        <div className="max-w-xs">
          <Logo />
          <p className="mt-4 text-sm leading-relaxed text-muted">
            一个属于你自己电脑的研究工作台。所有内容都是真实文件夹里的真实文件。
          </p>
        </div>

        <div className="grid grid-cols-2 gap-10 sm:grid-cols-3">
          <FooterCol title="产品">
            <FooterButton onClick={() => navigate("features")}>功能</FooterButton>
            <FooterButton onClick={() => navigate("download")}>下载</FooterButton>
            <FooterButton onClick={() => navigate("about")}>关于</FooterButton>
          </FooterCol>
          <FooterCol title="资源">
            <FooterLink href={`${REPO}/releases/latest`}>最新版本</FooterLink>
            <FooterLink href={`${REPO}#get-started`}>快速上手</FooterLink>
            <FooterLink href={`${REPO}/issues`}>反馈问题</FooterLink>
          </FooterCol>
          <FooterCol title="开源">
            <FooterLink href={REPO}>GitHub 仓库</FooterLink>
            <FooterLink href={`${REPO}/blob/main/LICENSE`}>GPL-3.0 许可</FooterLink>
          </FooterCol>
        </div>
      </Container>

      <div className="border-t border-border">
        <Container className="flex flex-col gap-2 py-6 text-xs text-subtle sm:flex-row sm:items-center sm:justify-between">
          <span>© {new Date().getFullYear()} Lattice. 基于 GPL-3.0-or-later 开源发布。</span>
          <span>为 macOS · Apple Silicon 打造</span>
        </Container>
      </div>
    </footer>
  );
}

function FooterCol({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-subtle">{title}</h3>
      {children}
    </div>
  );
}

function FooterButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-left text-sm text-muted transition-colors hover:text-foreground">
      {children}
    </button>
  );
}

function FooterLink({ children, href }: { children: React.ReactNode; href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-sm text-muted transition-colors hover:text-foreground"
    >
      {children}
    </a>
  );
}
