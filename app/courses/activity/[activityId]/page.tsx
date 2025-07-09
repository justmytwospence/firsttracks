import { fetchActivityWithStreams } from "@/app/actions/fetchActivity";
import { auth } from "@/auth";
import { notFound } from "next/navigation";
import ActivityDetail from "@/components/activity-detail";

export default async function ActivityPage({ params }) {
	const session = await auth();
	if (!session) {
		return null;
	}

	const { activityId } = await params;

	const { activity, streams } = await fetchActivityWithStreams(activityId);

	if (!activity) {
		notFound();
	}

	return <ActivityDetail activity={activity} activityStreams={streams} />;
}
