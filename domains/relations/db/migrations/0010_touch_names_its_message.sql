-- Decision 0050: a touch names the message whose hand-over it confirms, so the
-- cap counts a message and its touch once. Null for every other touch.
ALTER TABLE "relations"."touch" ADD COLUMN "message_id" uuid;--> statement-breakpoint
ALTER TABLE "relations"."touch" ADD CONSTRAINT "touch_message_id_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "relations"."message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "touch_message_uidx" ON "relations"."touch" USING btree ("message_id") WHERE "relations"."touch"."message_id" is not null;