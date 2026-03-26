# NemoClaw Dashboard Build Plan

## CONTRACT_VERSION: v1

## PLAN

### Phase 1: Telemetry Data Integration
**Objective:** Fetch real telemetry from OpenShell and expose it through API endpoints
**Exit Criteria:** API endpoints return real CPU, GPU, Disk, and Network data

### Phase 2: UI Component Architecture
**Objective:** Build modular, reusable UI components with dark/light mode
**Exit Criteria:** Components render correctly with proper styling and NVIDIA color scheme

### Phase 3: Telemetry Display
**Objective:** Implement speedometer-style gauges with selectable telemetry targets
**Exit Criteria:** Gauges show real data, sandboxes can be selected, combined telemetry works

### Phase 4: Dashboard Integration
**Objective:** Add "OpenClaw Gateway Dashboard" button and finalize layout
**Exit Criteria:** Button opens OpenClaw dashboard in new window, layout is responsive

## TASKS

### Phase 1: Telemetry Data Integration

#### Task 1.1: Fetch OpenShell Kubernetes Data
- **Owner:** Builder
- **Dependency:** None
- **Timeout:** 120s
- **Command:** `/Applications/Docker.app/Contents/Resources/bin/docker exec openshell-cluster-openshell kubectl get pods --all-namespaces -o json`
- **Acceptance Test:** JSON response with pod data returned

#### Task 1.2: Create Telemetry API Route
- **Owner:** Builder
- **Dependency:** Task 1.1
- **Timeout:** 120s
- **Command:** `/Applications/Docker.app/Contents/Resources/bin/docker exec openshell-cluster-openshell kubectl get pods --all-namespaces -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.podIP}{"\n"}{end}' > /tmp/openshell-pods.json`
- **Acceptance Test:** JSON file created with pod names and IPs

#### Task 1.3: Expose Telemetry via API
- **Owner:** Builder
- **Dependency:** Task 1.2
- **Timeout:** 120s
- **Command:** `/Applications/Docker.app/Contents/Resources/bin/docker exec openshell-cluster-openshell kubectl top pods --all-namespaces -o json`
- **Acceptance Test:** Real CPU/memory metrics returned

### Phase 2: UI Component Architecture

#### Task 2.1: Build Dark/Light Mode Component
- **Owner:** Builder
- **Dependency:** None
- **Timeout:** 120s
- **Command:** `/Applications/Docker.app/Contents/Resources/bin/docker exec openshell-cluster-openshell kubectl get configmaps -n openshell -o yaml > /tmp/openshell-configmaps.yaml`
- **Acceptance Test:** Config maps fetched successfully

#### Task 2.2: Create NVIDIA Styling
- **Owner:** Builder
- **Dependency:** Task 2.1
- **Timeout:** 120s
- **Command:** Update `/Users/markmckeen/nemo-shell-dashboard/app/globals.css` with:
  ```css
  @media (prefers-color-scheme: dark) {
    :root {
      --bg-color: #0a0a0a;
      --text-color: #76B900;
      --card-bg: #1a1a1a;
    }
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg-color: #f0f0f0;
      --text-color: #0D47A1;
      --card-bg: #ffffff;
    }
  }
  ```
- **Acceptance Test:** CSS classes render correctly in both modes

#### Task 2.3: Build Speedometer Gauge Component
- **Owner:** Builder
- **Dependency:** Task 2.2
- **Timeout:** 120s
- **Command:** Create `/Users/markmckeen/nemo-shell-dashboard/app/components/SpeedometerGauge.tsx` with SVG-based gauges
- **Acceptance Test:** Gauge renders with correct color and scale

### Phase 3: Telemetry Display

#### Task 3.1: Build Sandbox List Component
- **Owner:** Builder
- **Dependency:** Task 2.3
- **Timeout:** 120s
- **Command:** Create `/Users/markmckeen/nemo-shell-dashboard/app/components/SandboxList.tsx` with click handlers
- **Acceptance Test:** List renders with sandbox names and IPs

#### Task 3.2: Implement Combined Telemetry
- **Owner:** Builder
- **Dependency:** Task 3.1
- **Timeout:** 120s
- **Command:** Create `/Users/markmckeen/nemo-shell-dashboard/app/api/telemetry/combined/route.ts`
- **Acceptance Test:** Returns average metrics from all sandboxes

#### Task 3.3: Add Speedometer Gauges for Each Metric
- **Owner:** Builder
- **Dependency:** Task 3.2
- **Timeout:** 120s
- **Command:** Create gauge components for CPU, GPU, Disk, Network
- **Acceptance Test:** Gauges show real data with text labels

### Phase 4: Dashboard Integration

#### Task 4.1: Add "OpenClaw Gateway Dashboard" Button
- **Owner:** Builder
- **Dependency:** Task 3.3
- **Timeout:** 120s
- **Command:** Create `/Users/markmckeen/nemo-shell-dashboard/app/components/OpenClawButton.tsx` with `target="_blank"` and `href="http://localhost:18789"`
- **Acceptance Test:** Button opens OpenClaw dashboard in new window

#### Task 4.2: Final Layout and Responsiveness
- **Owner:** Builder
- **Dependency:** Task 4.1
- **Timeout:** 120s
- **Command:** Update `/Users/markmckeen/nemo-shell-dashboard/app/page.tsx` with new layout
- **Acceptance Test:** Layout is responsive and displays all components

## RISKS

### Risk 1: Kubernetes API Not Accessible
- **Trigger:** `kubectl` command fails in Docker container
- **Impact:** Cannot fetch telemetry data
- **Mitigation:** Use mock data fallback, explore alternative data sources

### Risk 2: GPU Metrics Not Available
- **Trigger:** `kubectl top pods` does not return GPU metrics
- **Impact:** GPU gauge shows incorrect data
- **Mitigation:** Use CPU/memory data as fallback, add GPU-aware monitoring

### Risk 3: Dark Mode CSS Not Applying
- **Trigger:** Media queries not working
- **Impact:** User sees wrong color scheme
- **Mitigation:** Add explicit theme toggles, test in both modes

## FAILURE TAXONOMY

### CLASS: DEPENDENCY_BLOCKED
- **Detection Signal:** `kubectl` command fails
- **Response:** Check Docker container status, verify kubectl is installed

### CLASS: SCOPE_DRIFT
- **Detection Signal:** User requests additional features mid-implementation
- **Response:** Confirm with user, re-plan if needed

### CLASS: VALIDATION_GAP
- **Detection Signal:** Cannot verify telemetry data is real
- **Response:** Add mock data fallback, verify against known values

## NEXT ACTION

**Build Phase 1, Task 1.1: Fetch OpenShell Kubernetes Data**

Command to run:
```bash
/Applications/Docker.app/Contents/Resources/bin/docker exec openshell-cluster-openshell kubectl get pods --all-namespaces -o json
```

Owner: Builder
Timeout: 120s
Acceptance Test: JSON response with pod data returned

---

*This plan is based on the Planner skill contract v1. All tasks are designed to be completed in one execution cycle with explicit verification criteria.*