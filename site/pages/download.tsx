import { Download, Cpu, ShieldCheck, ArrowUpRight, Check } from "lucide-react";
import { Container, LinkButton, Eyebrow } from "../ui";

const REPO = "https://github.com/leo1oel/lattice";
const RELEASES = `${REPO}/releases/latest`;

const STEPS = [
  "下载最新版本的 .dmg 安装包",
  "打开 dmg,把 Lattice 拖进「应用程序」文件夹",
  "首次打开时按提示确认来自开源开发者的应用",
  "选择或新建一个本地文件夹,开始你的第一个项目",
];

export function Download_() {
  return (
    <>
      <section className="border-b border-border bg-surface">
        <Container className="py-20 md:py-24">
          <div className="site-rise mx-auto max-w-3xl text-center">
            <Eyebrow>下载</Eyebrow>
            <h1 className="mt-5 text-balance font-serif text-5xl tracking-tight md:text-6xl">
              开始使用 Lattice
            </h1>
            <p className="mx-auto mt-5 text-pretty text-lg leading-relaxed text-muted">
              目前为 macOS(Apple Silicon)提供原生构建。免费、开源,无需注册账号。
            </p>
          </div>

          {/* Download card */}
          <div className="mx-auto mt-12 max-w-2xl overflow-hidden rounded-2xl border border-border-strong bg-background">
            <div className="flex flex-col items-center gap-5 p-8 text-center md:p-10">
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-foreground text-background">
                <Download size={28} />
              </span>
              <div>
                <h2 className="text-xl font-semibold text-foreground">Lattice for macOS</h2>
                <p className="mt-1 text-sm text-muted">Apple Silicon · 通过 GitHub Releases 分发</p>
              </div>
              <LinkButton variant="accent" size="lg" href={RELEASES} target="_blank" rel="noreferrer">
                <Download size={18} />
                下载最新版本
              </LinkButton>
              <a
                href={REPO}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-foreground"
              >
                在 GitHub 上查看源码
                <ArrowUpRight size={14} />
              </a>
            </div>
            <div className="grid grid-cols-1 divide-y divide-border border-t border-border sm:grid-cols-2 sm:divide-x sm:divide-y-0">
              <Spec icon={Cpu} title="系统要求" desc="macOS · Apple Silicon (M 系列芯片)" />
              <Spec icon={ShieldCheck} title="许可协议" desc="GPL-3.0-or-later · 完全开源" />
            </div>
          </div>
        </Container>
      </section>

      {/* Install steps */}
      <section>
        <Container className="py-16 md:py-20">
          <div className="mx-auto max-w-2xl">
            <h2 className="text-balance font-serif text-3xl tracking-tight md:text-4xl">安装步骤</h2>
            <ol className="mt-8 space-y-3">
              {STEPS.map((step, i) => (
                <li
                  key={i}
                  className="flex items-start gap-4 rounded-xl border border-border bg-surface px-5 py-4"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent-strong">
                    {i + 1}
                  </span>
                  <span className="pt-0.5 text-[0.95rem] leading-relaxed text-foreground">{step}</span>
                </li>
              ))}
            </ol>

            <div className="mt-10 rounded-xl border border-border bg-surface p-6">
              <h3 className="text-sm font-semibold text-foreground">其他平台?</h3>
              <p className="mt-2 flex items-start gap-2 text-sm leading-relaxed text-muted">
                <Check size={16} className="mt-0.5 shrink-0 text-accent" />
                目前 Lattice 专注于打磨 macOS 原生体验。想第一时间知道其他平台的进展,
                可以在 GitHub 上 Star 或 Watch 仓库。
              </p>
            </div>
          </div>
        </Container>
      </section>
    </>
  );
}

function Spec({
  icon: Icon,
  title,
  desc,
}: {
  icon: typeof Cpu;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex items-center gap-3 px-6 py-5">
      <Icon size={20} className="shrink-0 text-subtle" />
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-sm text-muted">{desc}</p>
      </div>
    </div>
  );
}
