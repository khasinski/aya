import Foundation
import FoundationModels

struct SummaryRequest: Decodable {
  let kind: String
  let lines: [String]
}

struct SummaryResult: Codable {
  let available: Bool
  let useful: Bool
  let summary: String
  let error: String?
}

struct ModelResult: Decodable {
  let useful: Bool
  let summary: String?
}

func emit(_ result: SummaryResult) {
  let encoder = JSONEncoder()
  if let data = try? encoder.encode(result), let text = String(data: data, encoding: .utf8) {
    print(text)
  } else {
    print(#"{"available":false,"useful":false,"summary":"","error":"encode-failed"}"#)
  }
}

func boundedSummary(_ value: String?) -> String {
  guard let value else { return "" }
  let cleaned = value
    .replacingOccurrences(of: "\n", with: " ")
    .replacingOccurrences(of: "\r", with: " ")
    .trimmingCharacters(in: .whitespacesAndNewlines)
  if cleaned.count <= 140 { return cleaned }
  return String(cleaned.prefix(137)).trimmingCharacters(in: .whitespacesAndNewlines) + "..."
}

func decodeModelResult(_ text: String) -> ModelResult? {
  let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
  let candidates: [String]
  if let start = trimmed.firstIndex(of: "{"), let end = trimmed.lastIndex(of: "}"), start <= end {
    candidates = [String(trimmed[start...end]), trimmed]
  } else {
    candidates = [trimmed]
  }
  for candidate in candidates {
    if let data = candidate.data(using: .utf8),
       let parsed = try? JSONDecoder().decode(ModelResult.self, from: data) {
      return parsed
    }
  }
  return nil
}

@available(macOS 26.0, *)
func summarize(_ request: SummaryRequest) async -> SummaryResult {
  let lines = request.lines
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty }
    .suffix(30)
    .joined(separator: "\n")

  if lines.isEmpty {
    return SummaryResult(available: true, useful: false, summary: "", error: nil)
  }

  let target = request.kind == "project"
    ? "2-3 very short Polish sentences for a project tab"
    : "one short Polish status line for a terminal row"
  let prompt = """
  You summarize recent terminal output for Aya, a local terminal manager.
  Return only strict JSON: {"useful": boolean, "summary": string}.
  Write \(target). Use present tense. Do not invent intent, names, services, or progress.
  If the output is just prompts, logs with no clear task, noise, errors without context, or not enough information, return {"useful":false,"summary":""}.
  Keep summary under 140 characters, no markdown, no code fences.

  Recent output:
  \(lines)
  """

  do {
    let session = LanguageModelSession(model: SystemLanguageModel.default)
    let response = try await session.respond(to: prompt)
    guard let parsed = decodeModelResult(response.content) else {
      return SummaryResult(available: true, useful: false, summary: "", error: "invalid-model-json")
    }
    let summary = boundedSummary(parsed.summary)
    return SummaryResult(
      available: true,
      useful: parsed.useful && !summary.isEmpty,
      summary: parsed.useful ? summary : "",
      error: nil
    )
  } catch {
    return SummaryResult(
      available: false,
      useful: false,
      summary: "",
      error: String(describing: error)
    )
  }
}

@main
struct AyaLocalSummary {
  static func main() async {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard let request = try? JSONDecoder().decode(SummaryRequest.self, from: input) else {
      emit(SummaryResult(available: false, useful: false, summary: "", error: "invalid-request"))
      return
    }

    if #available(macOS 26.0, *) {
      emit(await summarize(request))
    } else {
      emit(SummaryResult(available: false, useful: false, summary: "", error: "unsupported-macos"))
    }
  }
}
