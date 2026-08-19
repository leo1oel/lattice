import { ArrowRight, Check } from "lucide-react";
import { Container, Button, LinkButton, Eyebrow } from "../ui";
import { AppMockup } from "../components/app-mockup";
import { FEATURES } from "../data";
import type { Route } from "../use-route";

const REPO = "https://github.com/leo1oel/lattice";

export function Home({ navigate }: { navigate: (r: Route) => void }) {
  return (
    <>
      {/* Hero */}
      <section className="relative overflow-hidden">
        <Container className="pt-20 pb-16 md:pt-28 md:pb-20">
          <div className="site-rise mx-auto max-w-3xl text-center">
            <Eyebrow>为 macOS 打造 · 本地优先</Eyebrow>
            <h1 className="mt-6 text-balance font-serif text-5xl leading-[1.05] tracking-tight md:text-7xl">
              研究的每一步,
              <br />
              都在同一个工作台里
            </h1>
            <p className="mx-auto mt-6 max-w-xl text-pretty text-lg leading-relaxed text-muted">
              Lattice 把 LaTeX 写作、阅读、笔记、白板、文献管理、实时协作和 AI 研究助手,
              集中在一个 macOS 原生应用里——而这一切都是你电脑上真实的文件。
            </p>
            <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Button variant="accent" size="lg" onClick={() => navigate("download")}>
                免费下载 for macOS
              </Button>
              <Button variant="outline" size="lg" onClick={() => navigate("features")}>
                查看全部功能
                <ArrowRight size={16} />
              </Button>
            </div>
            <p className="mt-4 text-sm text-subtle">Apple Silicon · GPL-3.0 开源 · 无需账号即可开始</p>
          </div>

          <div className="site-rise mt-16" style={{ animationDelay: "120ms" }}>
            <AppMockup className="mx-auto max-w-4xl" />
          </div>
        </Container>
      </section>

      {/* Problem statement */}
      <section className="border-y border-border bg-surface">
        <Container className="py-16 md:py-20">
          <div className="mx-auto max-w-3xl text-center">
            <p className="text-balance text-2xl leading-relaxed text-foreground md:text-3xl">
              一篇论文往往在 LaTeX、PDF、笔记、草图、文献、协作者、Git 之间来回穿梭。
              <span className="text-subtle"> Lattice 让这些工作彼此相连,而不必离开你的电脑。</span>
            </p>
          </div>
        </Container>
      </section>

      {/* Feature bento */}
      <section>
        <Container className="py-20 md:py-24">
          <div className="max-w-2xl">
            <Eyebrow>一个工作台</Eyebrow>
            <h2 className="mt-4 text-balance font-serif text-4xl tracking-tight md:text-5xl">
              覆盖研究全流程的能力
            </h2>
            <p className="mt-4 text-pretty text-lg leading-relaxed text-muted">
              围绕 LaTeX 编辑器,是笔记、白板、文献、协作、历史与 AI——彼此打通,统一在一处。
            </p>
          </div>

          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {FEATURES.map((f) => (
              <article
                key={f.title}
                className="flex flex-col rounded-2xl border border-border bg-surface p-6 transition-colors hover:border-border-strong"
              >
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
                  <f.icon size={20} />
                </span>
                <h3 className="mt-5 text-base font-semibold text-foreground">{f.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{f.summary}</p>
              </article>
            ))}
          </div>

          <div className="mt-8 text-center">
            <Button variant="ghost" onClick={() => navigate("features")}>
              了解每个功能的细节
              <ArrowRight size={16} />
            </Button>
          </div>
        </Container>
      </section>

      {/* Local-first band */}
      <section className="border-t border-border bg-foreground text-background">
        <Container className="py-20 md:py-24">
          <div className="grid items-center gap-12 md:grid-cols-2">
            <div>
              <Eyebrow>
                <span className="text-background/60">你的数据,你做主</span>
              </Eyebrow>
              <h2 className="mt-4 text-balance font-serif text-4xl tracking-tight md:text-5xl">
                真实文件,真实文件夹
              </h2>
              <p className="mt-5 text-pretty text-lg leading-relaxed text-background/70">
                Lattice 不会把你的稿件变成私有格式,也不会把工作从你的电脑上带走。
                每一份内容都是本地的普通文件,你可以随时用 Git 管理,或用任何其他工具打开。
              </p>
            </div>
            <ul className="grid gap-3">
              {[
                "所有内容离线保存在本地文件夹",
                "开放格式:.tex、Markdown、图片一目了然",
                "可用 Git 做版本控制,与团队协作",
                "GPL-3.0 开源,代码完全公开",
              ].map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-3 rounded-xl border border-background/15 bg-background/5 px-5 py-4 text-background/90"
                >
                  <Check size={18} className="mt-0.5 shrink-0 text-background" />
                  <span className="text-[0.95rem] leading-relaxed">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </Container>
      </section>

      {/* CTA */}
      <section>
        <Container className="py-20 text-center md:py-28">
          <h2 className="mx-auto max-w-2xl text-balance font-serif text-4xl tracking-tight md:text-6xl">
            让你的研究,回到一个地方
          </h2>
          <p className="mx-auto mt-5 max-w-lg text-pretty text-lg leading-relaxed text-muted">
            现在就下载 Lattice,把散落在各处的写作、阅读与思考重新连起来。
          </p>
          <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <Button variant="accent" size="lg" onClick={() => navigate("download")}>
              免费下载 for macOS
            </Button>
            <LinkButton variant="outline" size="lg" href={REPO} target="_blank" rel="noreferrer">
              在 GitHub 上查看
            </LinkButton>
          </div>
        </Container>
      </section>
    </>
  );
}
