import type { ItemQty, Order, PublicConfig } from "@kitchensched/contracts";

/**
 * Verbatim copies of scenarios/easy/kitchen.json and
 * scenarios/easy/practice-stream.json, embedded as strings so the game tests
 * need no file system and no dependency on @kitchensched/scen.
 */

const KITCHEN_JSON = `{
  "protocol_version": "0.3.0-web",
  "scenario_id": "easy-01",
  "scenario_version": "1",
  "difficulty": "easy",
  "end_at_ms": 300000,
  "currency_unit": "credit_minor",
  "currency_scale": 100,
  "items": [
    {
      "id": "it.chicken_raw",
      "name": "Chicken Fillet",
      "supply": "unlimited_raw",
      "orderable": false,
      "price_minor": 0
    },
    {
      "id": "it.dough_raw",
      "name": "Bun Dough",
      "supply": "unlimited_raw",
      "orderable": false,
      "price_minor": 0
    },
    {
      "id": "it.fry_raw",
      "name": "Frozen Fries",
      "supply": "unlimited_raw",
      "orderable": false,
      "price_minor": 0
    },
    {
      "id": "it.chicken_grilled",
      "name": "Grilled Fillet",
      "supply": "produced",
      "orderable": false,
      "price_minor": 0
    },
    {
      "id": "it.chicken_fried",
      "name": "Fried Fillet",
      "supply": "produced",
      "orderable": false,
      "price_minor": 0
    },
    {
      "id": "it.fries_fried",
      "name": "Fried Fries",
      "supply": "produced",
      "orderable": false,
      "price_minor": 0
    },
    {
      "id": "it.baked_bun",
      "name": "Baked Bun",
      "supply": "produced",
      "orderable": false,
      "price_minor": 0
    },
    {
      "id": "it.sandwich_base",
      "name": "Grilled Sandwich Base",
      "supply": "produced",
      "orderable": false,
      "price_minor": 0
    },
    {
      "id": "it.crispy_base",
      "name": "Crispy Sandwich Base",
      "supply": "produced",
      "orderable": false,
      "price_minor": 0
    },
    {
      "id": "p.grilled_sandwich",
      "name": "Grilled Sandwich",
      "supply": "produced",
      "orderable": true,
      "price_minor": 850
    },
    {
      "id": "p.crispy_sandwich",
      "name": "Crispy Sandwich",
      "supply": "produced",
      "orderable": true,
      "price_minor": 950
    },
    {
      "id": "p.fries_box",
      "name": "Fries Box",
      "supply": "produced",
      "orderable": true,
      "price_minor": 420
    },
    {
      "id": "p.combo_box",
      "name": "Sandwich Combo",
      "supply": "produced",
      "orderable": true,
      "price_minor": 1520
    }
  ],
  "recipes": [
    {
      "id": "r.grill_chicken",
      "name": "Grill Fillet",
      "inputs": [
        {
          "item_id": "it.chicken_raw",
          "quantity": 1
        }
      ],
      "outputs": [
        {
          "item_id": "it.chicken_grilled",
          "quantity": 1
        }
      ],
      "station_options": [
        {
          "station_id": "st.grill",
          "duration_ms": 6000,
          "max_batches": 2
        }
      ]
    },
    {
      "id": "r.fry_chicken",
      "name": "Fry Fillet",
      "inputs": [
        {
          "item_id": "it.chicken_raw",
          "quantity": 1
        }
      ],
      "outputs": [
        {
          "item_id": "it.chicken_fried",
          "quantity": 1
        }
      ],
      "station_options": [
        {
          "station_id": "st.fryer",
          "duration_ms": 5000,
          "max_batches": 3
        }
      ]
    },
    {
      "id": "r.fry_fries",
      "name": "Fry Fries",
      "inputs": [
        {
          "item_id": "it.fry_raw",
          "quantity": 1
        }
      ],
      "outputs": [
        {
          "item_id": "it.fries_fried",
          "quantity": 1
        }
      ],
      "station_options": [
        {
          "station_id": "st.fryer",
          "duration_ms": 4000,
          "max_batches": 4
        }
      ]
    },
    {
      "id": "r.bake_bun",
      "name": "Bake Bun",
      "inputs": [
        {
          "item_id": "it.dough_raw",
          "quantity": 1
        }
      ],
      "outputs": [
        {
          "item_id": "it.baked_bun",
          "quantity": 1
        }
      ],
      "station_options": [
        {
          "station_id": "st.oven",
          "duration_ms": 3000,
          "max_batches": 4
        }
      ]
    },
    {
      "id": "r.assemble_grilled",
      "name": "Assemble Grilled Base",
      "inputs": [
        {
          "item_id": "it.chicken_grilled",
          "quantity": 1
        },
        {
          "item_id": "it.baked_bun",
          "quantity": 1
        }
      ],
      "outputs": [
        {
          "item_id": "it.sandwich_base",
          "quantity": 1
        }
      ],
      "station_options": [
        {
          "station_id": "st.counter",
          "duration_ms": 2000,
          "max_batches": 3
        }
      ]
    },
    {
      "id": "r.assemble_crispy",
      "name": "Assemble Crispy Base",
      "inputs": [
        {
          "item_id": "it.chicken_fried",
          "quantity": 1
        },
        {
          "item_id": "it.baked_bun",
          "quantity": 1
        }
      ],
      "outputs": [
        {
          "item_id": "it.crispy_base",
          "quantity": 1
        }
      ],
      "station_options": [
        {
          "station_id": "st.counter",
          "duration_ms": 2000,
          "max_batches": 3
        }
      ]
    },
    {
      "id": "r.pack_grilled_sandwich",
      "name": "Pack Grilled Sandwich",
      "inputs": [
        {
          "item_id": "it.sandwich_base",
          "quantity": 1
        }
      ],
      "outputs": [
        {
          "item_id": "p.grilled_sandwich",
          "quantity": 1
        }
      ],
      "station_options": [
        {
          "station_id": "st.packager",
          "duration_ms": 1800,
          "max_batches": 3
        }
      ]
    },
    {
      "id": "r.pack_crispy_sandwich",
      "name": "Pack Crispy Sandwich",
      "inputs": [
        {
          "item_id": "it.crispy_base",
          "quantity": 1
        }
      ],
      "outputs": [
        {
          "item_id": "p.crispy_sandwich",
          "quantity": 1
        }
      ],
      "station_options": [
        {
          "station_id": "st.packager",
          "duration_ms": 1800,
          "max_batches": 3
        }
      ]
    },
    {
      "id": "r.pack_fries_box",
      "name": "Pack Fries Box",
      "inputs": [
        {
          "item_id": "it.fries_fried",
          "quantity": 1
        }
      ],
      "outputs": [
        {
          "item_id": "p.fries_box",
          "quantity": 1
        }
      ],
      "station_options": [
        {
          "station_id": "st.packager",
          "duration_ms": 1500,
          "max_batches": 4
        }
      ]
    },
    {
      "id": "r.pack_combo_box",
      "name": "Pack Sandwich Combo",
      "inputs": [
        {
          "item_id": "it.sandwich_base",
          "quantity": 1
        },
        {
          "item_id": "it.fries_fried",
          "quantity": 1
        }
      ],
      "outputs": [
        {
          "item_id": "p.combo_box",
          "quantity": 1
        }
      ],
      "station_options": [
        {
          "station_id": "st.packager",
          "duration_ms": 2400,
          "max_batches": 2
        }
      ]
    }
  ],
  "stations": [
    {
      "id": "st.grill",
      "kind": "grill",
      "name": "Grill"
    },
    {
      "id": "st.fryer",
      "kind": "fryer",
      "name": "Fryer"
    },
    {
      "id": "st.oven",
      "kind": "oven",
      "name": "Oven"
    },
    {
      "id": "st.counter",
      "kind": "assembly",
      "name": "Counter"
    },
    {
      "id": "st.packager",
      "kind": "packaging",
      "name": "Packager"
    }
  ],
  "rules": {
    "clock": "paused_code",
    "settlement": "whole_order",
    "batch_timing": "fixed_within_capacity",
    "finish_at_deadline_counts": true,
    "delivery_duration_ms": 0,
    "cancellation": "unsupported"
  },
  "limits": {
    "init_wall_ms": 5000,
    "decision_wall_ms": 2000,
    "total_cpu_ms": 30000,
    "memory_mib": 256,
    "max_decisions": 20000,
    "max_actions_per_decision": 1024,
    "max_total_actions": 200000,
    "min_wake_delay_ms": 20,
    "max_message_bytes": 4194304,
    "max_stderr_bytes": 1048576,
    "max_pids": 64,
    "max_writable_mib": 64,
    "max_orders_per_run": 1024
  }
}`;

const STREAM_JSON = `{
  "version": "1",
  "scenario_id": "easy-01",
  "seed": 20261007,
  "generator_version": "scen/0.3.0",
  "difficulty": "easy",
  "orders": [
    {
      "at_ms": 60000,
      "items": [
        {
          "item_id": "p.crispy_sandwich",
          "quantity": 1
        },
        {
          "item_id": "p.combo_box",
          "quantity": 1
        },
        {
          "item_id": "p.grilled_sandwich",
          "quantity": 1
        }
      ]
    },
    {
      "at_ms": 75000,
      "items": [
        {
          "item_id": "p.combo_box",
          "quantity": 1
        },
        {
          "item_id": "p.fries_box",
          "quantity": 1
        },
        {
          "item_id": "p.crispy_sandwich",
          "quantity": 3
        }
      ]
    },
    {
      "at_ms": 90000,
      "items": [
        {
          "item_id": "p.crispy_sandwich",
          "quantity": 3
        },
        {
          "item_id": "p.combo_box",
          "quantity": 1
        }
      ]
    },
    {
      "at_ms": 105000,
      "items": [
        {
          "item_id": "p.crispy_sandwich",
          "quantity": 2
        },
        {
          "item_id": "p.grilled_sandwich",
          "quantity": 2
        },
        {
          "item_id": "p.fries_box",
          "quantity": 1
        }
      ]
    },
    {
      "at_ms": 120000,
      "items": [
        {
          "item_id": "p.crispy_sandwich",
          "quantity": 1
        },
        {
          "item_id": "p.grilled_sandwich",
          "quantity": 1
        }
      ]
    },
    {
      "at_ms": 135000,
      "items": [
        {
          "item_id": "p.combo_box",
          "quantity": 2
        },
        {
          "item_id": "p.grilled_sandwich",
          "quantity": 1
        }
      ]
    },
    {
      "at_ms": 150000,
      "items": [
        {
          "item_id": "p.fries_box",
          "quantity": 1
        },
        {
          "item_id": "p.grilled_sandwich",
          "quantity": 1
        },
        {
          "item_id": "p.crispy_sandwich",
          "quantity": 2
        }
      ]
    },
    {
      "at_ms": 165000,
      "items": [
        {
          "item_id": "p.fries_box",
          "quantity": 3
        },
        {
          "item_id": "p.combo_box",
          "quantity": 2
        },
        {
          "item_id": "p.grilled_sandwich",
          "quantity": 2
        }
      ]
    },
    {
      "at_ms": 180000,
      "items": [
        {
          "item_id": "p.crispy_sandwich",
          "quantity": 3
        },
        {
          "item_id": "p.fries_box",
          "quantity": 3
        }
      ]
    },
    {
      "at_ms": 195000,
      "items": [
        {
          "item_id": "p.combo_box",
          "quantity": 2
        }
      ]
    },
    {
      "at_ms": 210000,
      "items": [
        {
          "item_id": "p.combo_box",
          "quantity": 3
        }
      ]
    },
    {
      "at_ms": 225000,
      "items": [
        {
          "item_id": "p.crispy_sandwich",
          "quantity": 3
        },
        {
          "item_id": "p.grilled_sandwich",
          "quantity": 1
        }
      ]
    },
    {
      "at_ms": 240000,
      "items": [
        {
          "item_id": "p.fries_box",
          "quantity": 2
        },
        {
          "item_id": "p.crispy_sandwich",
          "quantity": 1
        }
      ]
    },
    {
      "at_ms": 255000,
      "items": [
        {
          "item_id": "p.grilled_sandwich",
          "quantity": 3
        },
        {
          "item_id": "p.fries_box",
          "quantity": 1
        }
      ]
    },
    {
      "at_ms": 270000,
      "items": [
        {
          "item_id": "p.crispy_sandwich",
          "quantity": 1
        },
        {
          "item_id": "p.combo_box",
          "quantity": 3
        },
        {
          "item_id": "p.fries_box",
          "quantity": 1
        }
      ]
    },
    {
      "at_ms": 285000,
      "items": [
        {
          "item_id": "p.combo_box",
          "quantity": 2
        }
      ]
    }
  ]
}`;

export interface StreamFile {
  version: string;
  scenario_id: string;
  seed: number;
  generator_version: string;
  difficulty: string;
  orders: { at_ms: number; items: ItemQty[] }[];
}

export const EASY_CONFIG: PublicConfig = JSON.parse(KITCHEN_JSON) as PublicConfig;
export const EASY_STREAM: StreamFile = JSON.parse(STREAM_JSON) as StreamFile;

/**
 * Host-side materialization (packages/scen/src/stream.ts): ids are assigned in
 * arrival order and values recomputed from the frozen config prices.
 */
export function materializeOrders(config: PublicConfig, stream: StreamFile): Order[] {
  const prices = new Map(
    config.items.filter((item) => item.orderable).map((item) => [item.id, item.price_minor]),
  );
  return stream.orders.map((entry, index) => {
    let value_minor = 0;
    const items: ItemQty[] = entry.items.map((line) => {
      value_minor += (prices.get(line.item_id) ?? 0) * line.quantity;
      return { item_id: line.item_id, quantity: line.quantity };
    });
    return { id: `o${index + 1}`, arrived_at_ms: entry.at_ms, items, value_minor };
  });
}

export const EASY_ORDERS: Order[] = materializeOrders(EASY_CONFIG, EASY_STREAM);
