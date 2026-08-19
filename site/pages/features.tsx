import { Container, Button, Eyebrow, cn } from "../ui";
import { FEATURES } from "../data";
import type { Route } from "../use-route";

export function Features({ navigate }: { navigate: (r: Route) => void }) {
  return (
    <>
      <section className="border-b border-border bg-surface">
        <Container className="py-20 text-center md:py-24">
          <div className="site-rise mx-auto max-w-2xl">
            <Eyebrow>功能</Eyebrow>
            <h1 className="mt-5 text-balance font-serif text-5xl tracking-tight md:text-6xl">
              一个应用,做完一篇论文该做的事
            </h1>
            <p className="mx-auto mt-5 text-pretty text-lg leading-relaxed text-muted">
              从写第一行 LaTeX,到读文献、画草图、多人协作、追溯历史——
              Lattice 把研究里真正花时间的部分都放进了同一个工作台。
            </p>
          </div>
        </Container>
      </section>

      <section>
        <Container className="py-16 md:py-20">
          <div className="grid gap-px overflow-hidden rounded-2xl border border-border bg-border">
            {FEATURES.map((f, i) => (
              <article
                key={f.title}
                className={cn(
                  "grid gap-6 bg-surface p-8 md:grid-cols-[auto_1fr] md:gap-10 md:p-10",
                )}
              >
                <div className="flex items-start gap-5 md:w-72">
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-strong">
                    <f.icon size={22} />
                  </span>
                  <div>
                    <span className="text-xs font-medium text-subtle">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <h2 className="mt-1 text-xl font-semibold tracking-tight text-foreground">
                      {f.title}
                    </h2>
                  </div>
                </div>
                <p className="max-w-2xl text-pretty text-[1.05rem] leading-relaxed text-muted">
                  {f.detail}
                </p>
              </article>
            ))}
          </div>
        </Container>
      </section>

      <section className="border-t border-border bg-surface">
        <Container className="py-16 text-center md:py-20">
          <h2 className="mx-auto max-w-xl text-balance font-serif text-3xl tracking-tight md:text-4xl">
            准备好把它们放到一起了吗?
          </h2>
          <div className="mt-8">
            <Button variant="accent" size="lg" onClick={() => navigate("download")}>
              下载 Lattice
            </Button>
          </div>
        </Container>
      </section>
    </>
  );
}
