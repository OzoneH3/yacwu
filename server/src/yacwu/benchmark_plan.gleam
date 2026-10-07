import gleam/list

pub type Stage {
  Stage(model: String, effort: String, target: Int)
}

pub fn batch(
  combinations: List(#(String, String)),
  economical: Bool,
) -> Result(List(Stage), String) {
  let keys =
    list.map(combinations, fn(combination) {
      combination.0 <> ":" <> combination.1
    })
  case
    list.length(combinations) >= 1
    && list.length(combinations) <= 6
    && list.length(list.unique(keys)) == list.length(combinations)
    && list.all(combinations, fn(combination) {
      combination.0 != "" && list.contains(["low", "medium"], combination.1)
    })
  {
    False -> Error("Choose one to six distinct model and thinking combinations")
    True -> {
      let stages =
        list.map(combinations, fn(combination) {
          Stage(combination.0, combination.1, 2)
        })
      Ok(
        list.index_map(stages, fn(stage, index) {
          Stage(..stage, target: case economical && index > 0 {
            True -> 1
            False -> 2
          })
        }),
      )
    }
  }
}
