import gleam/list

pub type Stage {
  Stage(model: String, effort: String, target: Int)
}

pub fn batch(
  models: List(String),
  economical: Bool,
) -> Result(List(Stage), String) {
  case
    list.length(models) >= 1
    && list.length(models) <= 3
    && list.length(list.unique(models)) == list.length(models)
    && !list.contains(models, "")
  {
    False -> Error("Choose one to three distinct models for the batch")
    True -> {
      let stages =
        list.flat_map(models, fn(model) {
          [Stage(model, "low", 2), Stage(model, "medium", 2)]
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
