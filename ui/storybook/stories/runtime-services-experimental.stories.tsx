import type { Meta, StoryObj } from "@storybook/react-vite";
import { RuntimeServicesReview } from "../prototypes/RuntimeServicesReview";

const meta = {
  title: "Runtime Services/00 Experimental opt-in",
  component: RuntimeServicesReview,
  parameters: { layout: "fullscreen" },
  args: { page: "experimental", scenario: "experiment-disabled" },
  decorators: [(Story, context) => <Story key={context.id} />],
} satisfies Meta<typeof RuntimeServicesReview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const DisabledByDefault: Story = {};
export const Enabled: Story = { args: { scenario: "ready" } };
export const TaskWithFeatureOff: Story = { args: { page: "task" } };
