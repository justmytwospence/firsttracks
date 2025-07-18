-- CreateTable
CREATE TABLE "activity_streams" (
    "id" TEXT NOT NULL,
    "activity_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "time" TIMESTAMP(3) NOT NULL,
    "altitude" DOUBLE PRECISION,
    "cadence" INTEGER,
    "distance" DOUBLE PRECISION,
    "gradient_smooth" DOUBLE PRECISION,
    "heartrate" INTEGER,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "moving" BOOLEAN,
    "temperature" DOUBLE PRECISION,
    "velocity_smooth" DOUBLE PRECISION,
    "watts" INTEGER,

    CONSTRAINT "activity_streams_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "activity_streams_time_idx" ON "activity_streams"("time");

-- CreateIndex
CREATE UNIQUE INDEX "activity_streams_activity_id_user_id_time_key" ON "activity_streams"("activity_id", "user_id", "time");

-- AddForeignKey
ALTER TABLE "activity_streams" ADD CONSTRAINT "activity_streams_activity_id_user_id_fkey" FOREIGN KEY ("activity_id", "user_id") REFERENCES "Activity"("id", "user_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_streams" ADD CONSTRAINT "activity_streams_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Create TimescaleDB hypertable (if TimescaleDB is available)
-- This will fail gracefully if TimescaleDB is not installed
DO $$
BEGIN
    -- Try to create the extension
    CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
    
    -- Create hypertable
    PERFORM create_hypertable('activity_streams', 'time', 
        chunk_time_interval => INTERVAL '1 day',
        if_not_exists => TRUE
    );
    
    RAISE NOTICE 'TimescaleDB hypertable created successfully for activity_streams';
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'TimescaleDB not available, continuing with regular table: %', SQLERRM;
END $$;