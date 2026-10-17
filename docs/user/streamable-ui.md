# Streamable answer visuals

Web and desktop assistant replies can render metrics, tables, and single-series
line charts directly from a fenced `t3-ui` JSONL block. Each line is one complete
JSON object. Tables and charts grow as their row and point records arrive. An
unfinished record stays hidden; completed records remain visible if a response
is interrupted. Closing the fence ends the visual's receiving indicator even
when more answer text follows.

The default paragraph streaming mode releases complete visual record lines
without waiting for the entire fence. The full-response streaming setting still
holds the response until completion. Ordinary code fences keep their existing
buffering behavior.

For example, these explicitly illustrative values render as a table and chart:

````markdown
```t3-ui
{"type":"metric","id":"latest","label":"Illustrative latest value","value":"121 USD"}
{"type":"table","id":"values","title":"Illustrative values","columns":["Day","USD"]}
{"type":"row","id":"values","cells":["Day 1",120]}
{"type":"row","id":"values","cells":["Day 2",123]}
{"type":"row","id":"values","cells":["Day 3",121]}
{"type":"chart","id":"trend","title":"Illustrative trend","xLabel":"Day","yLabel":"USD"}
{"type":"point","id":"trend","label":"Day 1","value":120}
{"type":"point","id":"trend","label":"Day 2","value":123}
{"type":"point","id":"trend","label":"Day 3","value":121}
```
````

Metric, table, and chart declarations may include `sources`, an array of
`{"label":"Source name","url":"https://example.com/page"}` objects. Agents must
verify their data and source URLs; the renderer validates links but does not
verify the claims. Exact chart values are available in **View data**.

This is a local bounded JSONL protocol, not OpenUI Lang or the Thesys runtime.
It does not execute generated JavaScript or HTML. Each block is limited to
128,000 characters, 512 records, 24 components, 200 rows or points per component,
and 12 table columns. Unsupported records expose the source fallback. Native
mobile clients currently show the fenced code rather than these components.
