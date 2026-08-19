import { ArrowUpRight, Heart, Zap, ShieldCheck } from "lucide-react";
import { Container, LinkButton, Eyebrow } from "../ui";

const REPO = "https://github.com/leo1oel/lattice";

const PRINCIPLES = [
  {
    icon: ShieldCheck,
    title: "本地优先",
    desc: "你的研究属于你自己的电脑。数据以开放格式存放在本地,不被锁进任何私有平台。",
  },
  {
    icon: Zap,
    title: "统一而不臃肿",
    desc: "把写作、阅读、笔记、协作真正连起来,而不是把十个工具塞进一个窗口。",
  },
  {
    icon: Heart,
    title: "开放源代码",
    desc: "以 GPL-3.0 开源,代码完全公开。任何人都能查看、改进并共同建设。",
  },
];

export function About() {
  return (
    <>
      <section className="border-b border-border bg-surface">
        <Container className="py-20 md:py-24">
          <div className="site-rise mx-auto max-w-3xl">
            <Eyebrow>关于</Eyebrow>
            <h1 className="mt-5 text-balance font-serif text-5xl leading-[1.08] tracking-tight md:text-6xl">
              研究很少发生在单一的编辑器里
            </h1>
            <div className="mt-8 space-y-5 text-pretty text-lg leading-relaxed text-muted">
              <p>
                一篇论文会在 LaTeX、PDF、笔记、草图、参考文献、协作者、Git,以及越来越多的
                AI 之间不断流动。当写作在一个工具里、阅读在另一个、图表在第三个、协作又在第四个,
                真正的研究就被工具的缝隙割裂了。
              </p>
              <p>
                Lattice 为写论文的研究者、博士生,以及所有用 LaTeX 写作的人而生。
                它围绕一个 macOS 原生的 LaTeX 编辑器,把类 Notion 的笔记、可视化白板、
                文献管理、实时协作、项目历史,以及一个能看见你项目的 AI 研究助手,
                收拢到同一个工作台里。
              </p>
              <p className="text-foreground">
                而且,所有这一切都是你 Mac 上真实文件夹里的真实文件。
              </p>
            </div>
          </div>
        </Container>
      </section>

      <section>
        <Container className="py-16 md:py-20">
          <div className="grid gap-4 md:grid-cols-3">
            {PRINCIPLES.map((p) => (
              <div key={p.title} className="rounded-2xl border border-border bg-surface p-7">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
                  <p.icon size={20} />
                </span>
                <h2 className="mt-5 text-lg font-semibold text-foreground">{p.title}</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted">{p.desc}</p>
              </div>
            ))}
          </div>
        </Container>
      </section>

      <section className="border-t border-border bg-foreground text-background">
        <Container className="flex flex-col items-start gap-8 py-16 md:flex-row md:items-center md:justify-between md:py-20">
          <div className="max-w-xl">
            <h2 className="text-balance font-serif text-3xl tracking-tight md:text-4xl">
              一起把它建设得更好
            </h2>
            <p className="mt-4 text-pretty leading-relaxed text-background/70">
              Lattice 是一个开源项目。无论是提交问题、参与讨论还是贡献代码,
              都欢迎你在 GitHub 上加入进来。
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <LinkButton
              variant="accent"
              size="lg"
              href={REPO}
              target="_blank"
              rel="noreferrer"
            >
              GitHub 仓库
              <ArrowUpRight size={16} />
            </LinkButton>
            <LinkButton
              size="lg"
              href={`${REPO}/issues`}
              target="_blank"
              rel="noreferrer"
              className="border border-background/25 bg-transparent text-background hover:bg-background/10"
            >
              反馈问题
            </LinkButton>
          </div>
        </Container>
      </section>
    </>
  );
}
