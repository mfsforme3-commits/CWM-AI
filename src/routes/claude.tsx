import { createFileRoute } from "@tanstack/react-router";

export const claudeRoute = createFileRoute("/claude")({
  component: Claude,
});

function Claude() {
  return (
    <div className="flex flex-col h-full">
      <main className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto">
          <div className="flex items-center space-x-4">
            <div>
              <h1 className="text-3xl font-bold">Claude</h1>
              <p className="text-gray-500 mt-1">
                This is a web-app dedicated to showcasing information about
                Claude.
              </p>
            </div>
          </div>
          <div className="mt-8">
            <h2 className="text-2xl font-bold">Key Features</h2>
            <ul className="mt-4 space-y-4">
              <li className="flex items-start">
                <div className="ml-4">
                  <h3 className="text-lg font-semibold">
                    Advanced AI Capabilities
                  </h3>
                  <p className="text-gray-500">
                    Claude is a powerful AI model with a wide range of
                    capabilities, including natural language processing, code
                    generation, and creative writing.
                  </p>
                </div>
              </li>
              <li className="flex items-start">
                <div className="ml-4">
                  <h3 className="text-lg font-semibold">
                    Real-time Conversation
                  </h3>
                  <p className="text-gray-500">
                    Engage in natural, real-time conversations with Claude to
                    get instant answers and insights.
                  </p>
                </div>
              </li>
              <li className="flex items-start">
                <div className="ml-4">
                  <h3 className="text-lg font-semibold">
                    Customizable and Adaptable
                  </h3>
                  <p className="text-gray-500">
                    Claude can be customized and adapted to suit your specific
                    needs, making it a versatile tool for a variety of
                    applications.
                  </p>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </main>
    </div>
  );
}
