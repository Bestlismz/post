CREATE SEQUENCE inbox_event_position;
ALTER TABLE outbox ADD COLUMN event_position bigint;
UPDATE outbox SET event_position=nextval('inbox_event_position');
ALTER TABLE outbox ALTER COLUMN event_position SET NOT NULL;
CREATE UNIQUE INDEX outbox_event_position_idx ON outbox(event_position);
CREATE INDEX outbox_inbox_replay_idx ON outbox(organization_id,event_position) WHERE kind IN ('inbox.operation','inbox.changed');

-- Hold this lock until commit so a replay cursor cannot skip an earlier,
-- uncommitted event. Assign the position only after acquiring the lock.
CREATE FUNCTION order_inbox_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(72419834);
  NEW.event_position := nextval('inbox_event_position');
  RETURN NEW;
END;
$$;
CREATE TRIGGER outbox_order BEFORE INSERT ON outbox FOR EACH ROW EXECUTE FUNCTION order_inbox_receipt();

CREATE FUNCTION emit_inbox_audit_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action='messenger.message_received' THEN
    INSERT INTO outbox(id,organization_id,kind,payload)
    VALUES(NEW.id,NEW.organization_id,'inbox.changed',jsonb_build_object(
      'receiptId',NEW.id,'resourceId',NEW.details->>'workItemId','resourceType','work_item','state','pending'));
  ELSIF NEW.action IN ('reply.prepared','reply.authorized','conversation.handoff',
    'delivery.attempting','delivery.sent','delivery.failed','delivery.unknown',
    'delivery.cancelled','delivery.reconciled','reply.preparation_failed') THEN
    INSERT INTO outbox(id,organization_id,kind,payload)
    VALUES(NEW.id,NEW.organization_id,'inbox.changed',jsonb_build_object(
      'receiptId',NEW.id,'resourceId',NEW.entity_id,'resourceType',NEW.entity_type,
      'state',split_part(NEW.action,'.',2)));
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER audit_inbox_receipt AFTER INSERT ON audit_entries FOR EACH ROW EXECUTE FUNCTION emit_inbox_audit_receipt();
