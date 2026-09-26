package com.basidekick.baskstream;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * The single list of protocol operations. Dispatch, the writes gate and
 * {@code capabilities.operations} all come from this table, so an operation cannot be
 * added without choosing its gate. {@code tests/protocol_contract.py} checks this table
 * against the session's handlers, {@code spec/baskstream-protocol.json} and the docs.
 */
final class BaskStreamOperations
{
  enum Gate
  {
    /** Does not change station state. */
    NONE,
    /** Changes station data. Dispatch requires {@code writesEnabled} before the handler runs. */
    WRITES,
    /**
     * Applies model plans. The plan engine checks {@code modelEditsEnabled} (which implies
     * {@code writesEnabled}) before the plan and again before each step, so dispatch does not.
     */
    MODEL_EDITS
  }

  static final class Operation
  {
    final String name;
    final Gate gate;

    private Operation(String name, Gate gate)
    {
      this.name = name;
      this.gate = gate;
    }
  }

  // Order is the order clients see in capabilities.operations.
  private static final Map<String, Operation> OPERATIONS = new LinkedHashMap<String, Operation>();

  static
  {
    add("ping", Gate.NONE);
    add("capabilities", Gate.NONE);
    add("browse", Gate.NONE);
    add("describe", Gate.NONE);
    add("search", Gate.NONE);
    add("read", Gate.NONE);
    add("subscribe", Gate.NONE);
    add("unsubscribe", Gate.NONE);
    add("replace_subscriptions", Gate.NONE);
    add("renew_subscriptions", Gate.NONE);
    add("release_subscriptions", Gate.NONE);
    add("subscription_status", Gate.NONE);
    add("write", Gate.WRITES);
    add("describe_write", Gate.NONE);
    add("read_history", Gate.NONE);
    add("describe_history", Gate.NONE);
    add("read_alarms", Gate.NONE);
    add("ack_alarm", Gate.WRITES);
    add("ack_alarms", Gate.WRITES);
    add("clear_alarm", Gate.WRITES);
    add("clear_alarms", Gate.WRITES);
    add("subscribe_alarms", Gate.NONE);
    add("unsubscribe_alarms", Gate.NONE);
    add("read_schedule", Gate.NONE);
    add("subscribe_model", Gate.NONE);
    add("unsubscribe_model", Gate.NONE);
    add("read_tags", Gate.NONE);
    add("write_tags", Gate.WRITES);
    add("write_relations", Gate.WRITES);
    add("describe_component_types", Gate.NONE);
    add("describe_component", Gate.NONE);
    // Previews and the convenience names below only store a plan; nothing changes until apply.
    add("preview_model_changes", Gate.NONE);
    add("apply_model_changes", Gate.MODEL_EDITS);
    add("model_plan_status", Gate.NONE);
    add("cancel_model_plan", Gate.NONE);
    add("create_components", Gate.NONE);
    add("update_component_properties", Gate.NONE);
    add("rename_component", Gate.NONE);
    add("move_components", Gate.NONE);
    add("delete_components", Gate.NONE);
    add("create_hierarchy", Gate.NONE);
    add("configure_hierarchy", Gate.NONE);
  }

  private static void add(String name, Gate gate)
  {
    if (OPERATIONS.put(name, new Operation(name, gate)) != null)
    {
      throw new IllegalStateException("Duplicate baskStream operation: " + name);
    }
  }

  /** Returns the operation, or null when the name is not part of the protocol. */
  static Operation get(String name)
  {
    return OPERATIONS.get(name);
  }

  static List<String> names()
  {
    return new ArrayList<String>(OPERATIONS.keySet());
  }

  private BaskStreamOperations()
  {
  }
}
