import { useState } from "react";
import { formatSize, measureSaves, percentile, type MeasureResult } from "./measure.ts";

type State =
  | { kind: "idle" }
  | { kind: "running"; step: string }
  | { kind: "done"; result: MeasureResult }
  | { kind: "failed"; error: string };

const ms = (value: number) => `${Math.round(value)} ms`;

export function App() {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function run() {
    setState({ kind: "running", step: "Starting" });
    try {
      const result = await measureSaves((step) => setState({ kind: "running", step }));
      setState({ kind: "done", result });
    } catch (error) {
      setState({ kind: "failed", error: String(error) });
    }
  }

  return (
    <main>
      <h1>draw</h1>
      <p>
        Save test. The page saves random bytes of 50 KB, 300 KB and 1 MB through the WebSocket of a
        new project, 10 times for each size, and shows the time from send to the server reply.
      </p>
      <button type="button" onClick={run} disabled={state.kind === "running"}>
        Run save test
      </button>
      {state.kind === "running" && <p role="status">{state.step}</p>}
      {state.kind === "failed" && <p role="alert">{state.error}</p>}
      {state.kind === "done" && <Results result={state.result} />}
    </main>
  );
}

function Results({ result }: { result: MeasureResult }) {
  const summary = {
    ...result,
    sizes: result.sizes.map(({ size, timesMs }) => ({
      size: formatSize(size),
      medianMs: Math.round(percentile(timesMs, 50)),
      p90Ms: Math.round(percentile(timesMs, 90)),
      maxMs: Math.round(Math.max(...timesMs)),
    })),
    connectMs: Math.round(result.connectMs),
    firstSaveMs: Math.round(result.firstSaveMs),
    raw: result.sizes.map(({ size, timesMs }) => ({ size, timesMs: timesMs.map(Math.round) })),
  };
  const text = JSON.stringify(summary, null, 2);
  return (
    <section>
      <p>
        Worker data center: <b>{result.workerColo}</b>. Durable Object data center:{" "}
        <b>{result.objectColo}</b>. Connect: {ms(result.connectMs)}. First save of 1 KB, which also
        creates the Durable Object: {ms(result.firstSaveMs)}.
      </p>
      <table>
        <thead>
          <tr>
            <th>Payload</th>
            <th>Median</th>
            <th>90th percentile</th>
            <th>Max</th>
          </tr>
        </thead>
        <tbody>
          {summary.sizes.map((row) => (
            <tr key={row.size}>
              <td>{row.size}</td>
              <td>{row.medianMs} ms</td>
              <td>{row.p90Ms} ms</td>
              <td>{row.maxMs} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Copy this text and send it back:{" "}
        <button type="button" onClick={() => navigator.clipboard.writeText(text)}>
          Copy
        </button>
      </p>
      <textarea readOnly rows={12} value={text} />
    </section>
  );
}
