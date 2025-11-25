import React, { useState, useEffect } from "react";
import { Brain, ChevronDown, Loader } from "lucide-react";
import { VanillaMarkdownParser } from "./DyadMarkdownParser";
import { CustomTagState } from "./stateTypes";
import { DyadTokenSavings } from "./DyadTokenSavings";
import { motion, AnimatePresence } from "framer-motion";

interface DyadThinkProps {
  node?: any;
  children?: React.ReactNode;
}

export const DyadThink: React.FC<DyadThinkProps> = ({ children, node }) => {
  const state = node?.properties?.state as CustomTagState;
  const inProgress = state === "pending";
  const [isExpanded, setIsExpanded] = useState(inProgress);

  // Check if content matches token savings format
  const tokenSavingsMatch =
    typeof children === "string"
      ? children.match(
          /^dyad-token-savings\?original-tokens=([0-9.]+)&smart-context-tokens=([0-9.]+)$/,
        )
      : null;

  // Auto-collapse when finished thinking
  useEffect(() => {
    if (!inProgress && isExpanded) {
      // Small delay to let the user see it finished if they were watching
      const timer = setTimeout(() => setIsExpanded(false), 800);
      return () => clearTimeout(timer);
    }
  }, [inProgress]);

  // Auto-expand if thinking starts
  useEffect(() => {
    if (inProgress) {
      setIsExpanded(true);
    }
  }, [inProgress]);


  // If it's token savings format, render DyadTokenSavings component
  if (tokenSavingsMatch) {
    const originalTokens = parseFloat(tokenSavingsMatch[1]);
    const smartContextTokens = parseFloat(tokenSavingsMatch[2]);
    return (
      <DyadTokenSavings
        originalTokens={originalTokens}
        smartContextTokens={smartContextTokens}
      />
    );
  }

  return (
    <div className="my-4">
      <motion.div
        layout
        initial={false}
        className={`overflow-hidden rounded-xl border transition-colors duration-200 ${
          inProgress
            ? "border-purple-200 dark:border-purple-800 bg-purple-50/50 dark:bg-purple-900/10"
            : "border-border bg-(--background-lightest) dark:bg-zinc-900/50"
        }`}
      >
        <motion.button
          layout="position"
          onClick={() => setIsExpanded(!isExpanded)}
          className="flex w-full items-center justify-between px-4 py-3 text-left"
        >
          <div className="flex items-center gap-2.5">
            <div className={`relative flex h-6 w-6 items-center justify-center rounded-md ${inProgress ? 'bg-purple-100 dark:bg-purple-900/50' : 'bg-gray-100 dark:bg-zinc-800'}`}>
                {inProgress ? (
                    <Loader size={14} className="text-purple-600 dark:text-purple-400 animate-spin" />
                ) : (
                    <Brain size={14} className="text-gray-500 dark:text-gray-400" />
                )}
            </div>
            <span className={`text-sm font-medium ${inProgress ? 'text-purple-700 dark:text-purple-300' : 'text-gray-600 dark:text-gray-400'}`}>
              {inProgress ? "Reasoning..." : "Thought Process"}
            </span>
          </div>
          
          <motion.div
            animate={{ rotate: isExpanded ? 180 : 0 }}
            transition={{ duration: 0.2 }}
            className="text-gray-400"
          >
            <ChevronDown size={16} />
          </motion.div>
        </motion.button>

        <AnimatePresence initial={false}>
          {isExpanded && (
            <motion.div
              key="content"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeInOut" }}
            >
              <div className="px-4 pb-4 pt-0">
                <div className="prose dark:prose-invert prose-sm max-w-none text-gray-600 dark:text-gray-300 prose-p:leading-relaxed">
                   {typeof children === "string" ? (
                    <VanillaMarkdownParser content={children} />
                  ) : (
                    children
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
};
