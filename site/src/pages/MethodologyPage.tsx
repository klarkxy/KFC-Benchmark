import { CONTRACT_SUMMARY } from "../CONTRACT_SUMMARY";

export function MethodologyPage(): JSX.Element {
  return (
    <section className="stack doc">
      <header className="doc-head">
        <h2>方法与协议</h2>
        <p className="muted">
          本站只展示 CI 产出的结果文件，不重算官方分数；所有结论都来自已发布的
          leaderboard.json 与回放事件流。
        </p>
      </header>

      <nav className="toc">
        {CONTRACT_SUMMARY.map((section) => (
          <button
            key={section.id}
            type="button"
            onClick={() =>
              document
                .getElementById(`methodology-${section.id}`)
                ?.scrollIntoView({ behavior: "smooth", block: "start" })
            }
          >
            {section.heading}
          </button>
        ))}
      </nav>

      {CONTRACT_SUMMARY.map((section) => (
        <article key={section.id} id={`methodology-${section.id}`} className="panel doc-section">
          <h3>{section.heading}</h3>
          {section.blocks.map((block) => (
            <div key={block.title} className="doc-block">
              <h4>{block.title}</h4>
              {block.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              {block.bullets ? (
                <ul>
                  {block.bullets.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </article>
      ))}
    </section>
  );
}
